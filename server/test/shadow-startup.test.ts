import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type AppConfig } from '../src/config.js';
import { claimStateDirectory } from '../src/state-directory.js';

const fixture = vi.hoisted(() => ({ config: undefined as AppConfig | undefined, app: undefined as Record<string, unknown> | undefined,
  listen: vi.fn(), bridgeListen: vi.fn(), hermesStart: vi.fn(), paseoStart: vi.fn(),
  hermesArgs: vi.fn(), paseoArgs: vi.fn(), helperArgs: vi.fn(), skillsVersion: vi.fn(async () => 0) }));

vi.mock('../src/config.js', async (original) => ({ ...await original<object>(), loadConfig: () => fixture.config, loadStartupConfig: () => fixture.config }));
vi.mock('../src/app.js', () => ({ buildApp: async (deps: Record<string, unknown>) => {
  fixture.app = deps;
  return { listen: fixture.listen, close: vi.fn() };
} }));
vi.mock('../src/bridge/server.js', () => ({ BRIDGE_HOST: '127.0.0.1', buildBridgeServer: async () => ({ listen: fixture.bridgeListen, close: vi.fn() }) }));
vi.mock('../src/hermes/adapter.js', () => ({ HermesAdapter: class {
  constructor(...args: unknown[]) { fixture.hermesArgs(...args); }
  start = fixture.hermesStart;
  stop() {}
  dashboard() { return undefined; }
  setWatching() {}
} }));
vi.mock('../src/paseo/adapter.js', () => ({ PaseoAdapter: class {
  constructor(...args: unknown[]) { fixture.paseoArgs(...args); }
  start = fixture.paseoStart;
  stop() {}
  useLineage() {}
  useConfigWriter() {}
  setWatching() {}
  async schedulesList() { return []; }
} }));
vi.mock('../src/connectors/helper.js', () => ({ readHelperToken: () => 'fake-helper-token', HelperClient: class {
  constructor(...args: unknown[]) { fixture.helperArgs(...args); }
  skillsVersion = fixture.skillsVersion;
} }));
vi.mock('../src/security/access.js', () => ({ remoteAccessKeys: () => ({ keySource: vi.fn(), stop() {} }), createAccessVerifier: () => vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe.each([
  ['shadow', undefined, 'shadow'], ['primary', undefined, 'primary'],
  [undefined, 'shadow', 'shadow'], ['primary', 'shadow', 'shadow'], ['shadow', 'primary', 'shadow'],
] as const)('config %s / env %s server startup wiring', (configRole, envRole, role) => {
  it('shares one gate across all services and creates only an ownership marker in shadow', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const state = mkdtempSync(join(tmpdir(), 'wayroost-startup-test-'));
    fixture.config = parseConfig({ role: configRole, stateDir: state,
      listen: { port: 8890 }, bridge: { enabled: true, port: 8893 }, helper: { enabled: true, port: 8894 }, feed: { enabled: true },
      hermes: { url: 'http://127.0.0.1:8892' }, paseo: { url: 'ws://127.0.0.1:8895' },
      publicOrigin: 'https://wayroost.example.com', access: { teamDomain: 'https://demo.cloudflareaccess.com', aud: 'fake-audience', allowedEmails: ['you@example.com'] },
    }, { env: envRole ? { WAYROOST_ROLE: envRole } : {} });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processOn = vi.spyOn(process, 'on').mockReturnValue(process);
    await import('../src/index.js');
    expect(fixture.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8890 });
    expect(fixture.bridgeListen).toHaveBeenCalledTimes(role === 'primary' ? 1 : 0);
    expect(fixture.hermesStart).toHaveBeenCalledOnce();
    expect(fixture.paseoStart).toHaveBeenCalledOnce();
    const feed = fixture.app?.feed as { stop(): void; deps: { background: unknown } };
    const schedules = fixture.app?.schedules as { deps: { background: unknown } };
    const connectors = fixture.app?.connectors as { deps: { background: unknown } };
    expect(feed.deps.background).toBe(schedules.deps.background);
    expect(feed.deps.background).toBe(connectors.deps.background);
    const gate = feed.deps.background;
    const options = fixture.hermesArgs.mock.calls[0]![4] as { background: unknown; lineage: { background: unknown } };
    expect(options.background).toBe(gate);
    expect(options.lineage.background).toBe(gate);
    expect(fixture.paseoArgs.mock.calls[0]![5]).toBe(gate);
    expect(fixture.helperArgs.mock.calls[0]![2]).toBe(role);
    // The completion relay needs the bridge, which only a primary runs; it shares the gate too.
    const tasks = fixture.app?.tasks as { stop(): void; deps: { background: unknown } } | undefined;
    if (role === 'primary') expect(tasks?.deps.background).toBe(gate);
    else expect([fixture.app?.tasks, fixture.app?.workerUpdates]).toEqual([undefined, undefined]);
    expect(fixture.app?.logger).toEqual({ level: expect.any(String), name: 'Wayroost' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Wayroost started'));
    expect(processOn.mock.calls.map(([event]) => event)).toContain('SIGTERM');
    // Both roles keep the pairing recovery socket: a shadow is paired like any server (sudo wayroost pair).
    expect(readdirSync(state).sort()).toEqual(role === 'primary' ? ['.wayroost-role', 'bridge-token', 'pairing', 'paseo-client-id', 'push.json'] : ['.wayroost-role', 'pairing']);
    feed.stop();
    tasks?.stop();
    (fixture.app?.skills as { stop(): void }).stop();
  });
});

it('refuses primary-owned state before constructing services or binding a shadow listener', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const stateDir = claimStateDirectory(mkdtempSync(join(tmpdir(), 'wayroost-startup-test-')), 'primary');
  fixture.config = { ...parseConfig({ stateDir, listen: { port: 8890 },
    publicOrigin: 'https://wayroost.example.com',
    access: { teamDomain: 'https://demo.cloudflareaccess.com', aud: 'fake-audience', allowedEmails: ['you@example.com'] },
  }, { env: {} }), role: 'shadow' };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fake-startup-exit'); });
  await expect(import('../src/index.js')).rejects.toThrow('fake-startup-exit');
  expect(exit).toHaveBeenCalledWith(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('belongs to primary'));
  for (const called of [fixture.hermesArgs, fixture.paseoArgs, fixture.helperArgs, fixture.listen, fixture.bridgeListen]) {
    expect(called).not.toHaveBeenCalled();
  }
  expect(readdirSync(stateDir)).toEqual(['.wayroost-role']);
});
