import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationStatus, ConversationSummary, PhoneStatus, SourceState } from '../../shared/protocol.js';
import { HermesAdapter, type Logger } from '../src/hermes/adapter.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { BusyReporter, countBusy, phoneSource, type BusySources } from '../src/busy.js';
import type { BusyCounts } from '../src/supervisor-client.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';
import { FakeSupervisor, gate } from './fake-supervisor.js';
import { BackgroundGate } from '../src/background.js';

// What "restart when idle" waits on: the counts this server pushes to the
// supervisor (POST /v1/busy), and when it pushes nothing because it can't know.

const quiet: Logger = { info() {}, warn() {}, error() {} };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function row(status: ConversationStatus): ConversationSummary {
  return { source: 'paseo', id: `demo-${status}`, title: 'Demo chat', status, updatedAt: 1_700_000_000_000, pendingApprovals: 0 };
}

function source(state: SourceState, rows: ConversationStatus[] | Error = []): BusySources['paseo'] {
  return {
    status: () => ({ source: 'paseo', state }),
    listConversations: async () => {
      if (rows instanceof Error) throw rows;
      return rows.map(row);
    },
  };
}

/** Hermes, which counts its own running turns (HermesAdapter.activeTurns). */
function hermes(state: SourceState, turns: number | Error = 0): BusySources['hermes'] {
  return {
    status: () => ({ source: 'hermes', state }),
    activeTurns: async () => {
      if (turns instanceof Error) throw turns;
      return turns;
    },
  };
}

const phone = (status: PhoneStatus | Error) => ({
  phone: async () => {
    if (status instanceof Error) throw status;
    return status;
  },
});
const offPhone = phone({ running: false, ok: false, pinSet: false, off: true });

describe('counting what is running', () => {
  it('counts turns working or waiting on an approval, in each source', async () => {
    expect(
      await countBusy({
        paseo: source('connected', ['running', 'needs_approval', 'idle', 'error']),
        hermes: hermes('connected', 1),
        phone: phone({ running: true, ok: true, pinSet: true, activeCalls: 1 }),
      }),
    ).toEqual({ paseoRunning: 2, hermesRunning: 1, calls: 1 });
  });

  it('counts nothing when both sources say idle and the phone line is known to be off', async () => {
    expect(
      await countBusy({ paseo: source('connected'), hermes: hermes('connected'), phone: phone({ running: false, ok: false, pinSet: false, off: true }) }),
    ).toEqual({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
  });

  it("says it can't know rather than send a zero it hasn't seen", async () => {
    const ok = source('connected');
    const none = hermes('connected');
    for (const state of ['connecting', 'disconnected', 'needs_credentials', 'error'] as const) {
      expect(await countBusy({ paseo: source(state), hermes: none, phone: offPhone }), state).toBeNull();
      expect(await countBusy({ paseo: ok, hermes: hermes(state), phone: offPhone }), state).toBeNull();
    }
    expect(await countBusy({ paseo: source('connected', new Error('gone')), hermes: none, phone: offPhone })).toBeNull();
    expect(await countBusy({ paseo: ok, hermes: none, phone: phone(new Error('helper down')) })).toBeNull();
    expect(await countBusy({ paseo: ok, hermes: none, phone: phone({ running: true, ok: true, pinSet: true }) })).toBeNull();
    expect(await countBusy({ paseo: ok, hermes: none, phone: phone({ running: true, ok: true, pinSet: true, activeCalls: -1 }) })).toBeNull();
  });

  it.each(['paseo', 'hermes'] as const)('keeps a disabled %s integration unknown even when the other sources are idle', async (disabled) => {
    const sources = { paseo: source('connected'), hermes: hermes('connected'), phone: offPhone };
    if (disabled === 'paseo') sources.paseo = source('disabled');
    else sources.hermes = hermes('disabled');
    // Disabling Wayroost's adapter does not stop the independently running service.
    expect(await countBusy(sources)).toBeNull();
  });
});

describe('counting calls', () => {
  const ok = { paseo: source('connected'), hermes: hermes('connected') };

  it('counts no calls only when the line is known to be off', async () => {
    expect(await countBusy({ ...ok, phone: phone({ running: false, ok: false, pinSet: false, off: true }) })).toEqual({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
    // The helper's answer when the line didn't answer in time: a call may still be up.
    expect(await countBusy({ ...ok, phone: phone({ running: false, ok: false, pinSet: false }) })).toBeNull();
    expect(await countBusy({ ...ok, phone: phone({ running: false, ok: false, pinSet: false, off: false }) })).toBeNull();
  });

  it('takes the count the line gave, and no count is not zero', async () => {
    expect(await countBusy({ ...ok, phone: phone({ running: true, ok: true, pinSet: true, activeCalls: 0 }) })).toEqual({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
    expect(await countBusy({ ...ok, phone: phone({ running: true, ok: false, pinSet: true, activeCalls: 2 }) })).toEqual({ paseoRunning: 0, hermesRunning: 0, calls: 2 });
    expect(await countBusy({ ...ok, phone: phone({ running: true, ok: true, pinSet: true }) })).toBeNull();
  });

  it('keeps calls unknown without a helper, whether it is configured or not', async () => {
    const helper = phone({ running: true, ok: true, pinSet: true, activeCalls: 1 });
    expect(phoneSource(helper, true)).toBe(helper);
    expect(phoneSource(undefined, false)).toBeUndefined();
    expect(await countBusy(ok)).toBeNull();
    expect(await countBusy({ ...ok, phone: phoneSource(undefined, false) })).toBeNull();
    const missing = phoneSource(undefined, true);
    expect(missing).toBeDefined();
    expect(await countBusy({ ...ok, phone: missing })).toBeNull();
  });
});

describe('counting Hermes', () => {
  it("asks Hermes for its running turns instead of reading its inbox, which can't vouch for a zero", async () => {
    // The inbox says nothing is running (it leaves out scheduled jobs, and only follows
    // live state while a page is open), but Hermes itself counts a scheduled job.
    const inbox = { ...hermes('connected', 1), listConversations: async () => [row('idle')] };
    expect(await countBusy({ paseo: source('connected'), hermes: inbox, phone: offPhone })).toEqual({ paseoRunning: 0, hermesRunning: 1, calls: 0 });
  });

  it("sends nothing when Hermes can't say how many turns are running", async () => {
    const ok = source('connected');
    expect(await countBusy({ paseo: ok, hermes: hermes('connected', new Error('status unreadable')), phone: offPhone })).toBeNull();
    expect(await countBusy({ paseo: ok, hermes: { status: () => ({ source: 'hermes', state: 'connected' }) }, phone: offPhone })).toBeNull();
    for (const odd of [-1, 1.5, Number.NaN]) expect(await countBusy({ paseo: ok, hermes: hermes('connected', odd), phone: offPhone }), String(odd)).toBeNull();
  });
});

describe('Hermes activity evidence', () => {
  const stops: Array<() => Promise<unknown> | void> = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()!();
  });

  /** A connected backend with no page open. Each call creates a separate process fixture. */
  async function connected(running = false) {
    const fake = new FakeHermes();
    fake.running = running;
    await fake.start();
    stops.push(() => fake.stop());
    const dir = mkdtempSync(join(tmpdir(), 'sb-busy-'));
    stops.push(() => rmSync(dir, { recursive: true, force: true }));
    new SecretStore(dir).writeHermes(FAKE_USER);
    const adapter = new HermesAdapter(fake.url, new EventHub(), new SecretStore(dir), quiet, { background: new BackgroundGate('primary') });
    stops.push(() => adapter.stop());
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    return { fake, adapter };
  }

  function secondary(fake: FakeHermes): void {
    fake.apiProfiles = { profiles: [{ name: 'default' }, { name: 'demo-secondary' }] };
    fake.profileStatus['demo-secondary'] = { ...fake.apiStatus };
    fake.profileCronJobs['demo-secondary'] = [];
    fake.profileCronRuns['demo-secondary'] = [];
  }

  const counts = (adapter: HermesAdapter) => countBusy({ paseo: source('connected'), hermes: adapter, phone: offPhone });

  it.each(['default', 'demo-secondary'])('keeps failed %s gateway identity probes unknown even when they return false', async (profile) => {
    const { fake, adapter } = await connected();
    secondary(fake);
    const failed = {
      gateway_running: false, gateway_state: null, active_agents: 0,
      gateway_updated_at: null, gateway_heartbeat_stale_s: null,
    };
    if (profile === 'default') fake.apiStatus = failed;
    else fake.profileStatus[profile] = failed;
    expect(await counts(adapter)).toBeNull();
  });

  it.each(['stopped', 'running', 'startup_failed', null])('does not use a false gateway flag with retained state %s as proof of zero', async (state) => {
    const { fake, adapter } = await connected();
    fake.apiStatus = { ...fake.apiStatus, gateway_running: false, gateway_state: state };
    expect(await counts(adapter)).toBeNull();
  });

  const invalidRuntime = [
    {}, { active_agents: null }, { active_agents: false }, { active_agents: 'malformed' },
    { active_agents: -1 }, { active_agents: 0.5 }, { active_agents: [] },
  ];
  describe.each(['default', 'demo-secondary'])('the original %s runtime count', (profile) => {
    it.each(invalidRuntime)('keeps a fresh normalized zero unknown when raw evidence is %j', async (runtime) => {
      const { fake, adapter } = await connected();
      secondary(fake);
      if (profile === 'default') fake.apiRuntime = runtime;
      else fake.profileRuntime[profile] = runtime;
      const status = await adapter.dashboard()!.json<Record<string, unknown>>(`/api/status?profile=${profile}`);
      // Hermes hides the invalid raw value: every HTTP guard in the old counter passes.
      expect(status.active_agents).toBe(0);
      expect(status.gateway_running).toBe(true);
      expect(status.gateway_updated_at).toEqual(expect.any(String));
      expect(status).not.toHaveProperty('runtime');
      expect(await counts(adapter)).toBeNull();
    });
  });

  it('keeps an unavailable runtime file unknown even when the HTTP status has a fresh timestamp', async () => {
    const { fake, adapter } = await connected();
    fake.apiRuntime = null;
    expect(await counts(adapter)).toBeNull();
  });

  it('keeps independent desktop work unknown when the connected backend and all gateways look idle', async () => {
    const primary = await connected();
    secondary(primary.fake);
    const desktop = await connected(true);
    // A real second HTTP/WebSocket fixture owns the secondary profile's interactive turn.
    await expect.poll(async () => (await desktop.adapter.listConversations())[0]?.status).toBe('running');
    expect((await primary.adapter.listConversations())[0]?.status).toBe('idle');
    expect(primary.fake.apiStatus!.active_agents).toBe(0);
    expect(primary.fake.profileStatus['demo-secondary']!.active_agents).toBe(0);
    expect(primary.fake.profileCronJobs['demo-secondary']).toEqual([]);
    expect(await counts(primary.adapter)).toBeNull();
  });

  it('does not infer complete backend coverage from a single profile or a shared gateway', async () => {
    const { fake, adapter } = await connected();
    expect(await counts(adapter)).toBeNull();
    secondary(fake);
    fake.apiStatus = { ...fake.apiStatus, gateway_shared_with: ['default', 'demo-secondary'] };
    fake.profileStatus['demo-secondary'] = { ...fake.apiStatus };
    expect(await counts(adapter)).toBeNull();
  });

  it('keeps partial positive counts unknown rather than present them as a complete count', async () => {
    const { fake, adapter } = await connected(true);
    fake.apiStatus = { ...fake.apiStatus, active_agents: 2 };
    fake.cronJobs = [{ id: 'demo-job', state: 'running' }];
    fake.cronRuns = [{ id: 'cron_demo-job_demo-run', source: 'cron', ended_at: null }];
    expect(await counts(adapter)).toBeNull();
  });

  it.each(['failed-probe', 'normalized-count', 'backend-coverage'])('sends no idle report with incomplete %s evidence', async (kind) => {
    const { fake, adapter } = await connected();
    if (kind === 'failed-probe') fake.apiStatus = { gateway_running: false };
    if (kind === 'normalized-count') fake.apiRuntime = { active_agents: null };
    if (kind === 'backend-coverage') secondary(fake);
    const supervisor = new FakeSupervisor();
    let attempts = 0;
    const reporter = new BusyReporter(supervisor, () => {
      attempts += 1;
      return counts(adapter);
    }, quiet, 20);
    stops.push(() => reporter.stop());
    reporter.start();
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(3);
    reporter.stop();
    // Drain any in-flight count before checking the supervisor's captured posts.
    await counts(adapter);
    expect(supervisor.reported).toEqual([]);
  });
});

describe('pushing the counts', () => {
  const reporters: BusyReporter[] = [];
  afterEach(() => {
    while (reporters.length) reporters.pop()!.stop();
  });
  const idle: BusyCounts = { paseoRunning: 0, hermesRunning: 0, calls: 0 };

  it('pushes at once and then on its interval, until it is stopped', async () => {
    const supervisor = new FakeSupervisor();
    const reporter = new BusyReporter(supervisor, async () => idle, quiet, 20);
    reporters.push(reporter);
    reporter.start();
    await expect.poll(() => supervisor.reported.length).toBeGreaterThanOrEqual(3);
    expect(supervisor.reported.every((counts) => JSON.stringify(counts) === JSON.stringify(idle))).toBe(true);

    reporter.stop();
    const sent = supervisor.reported.length;
    await wait(80);
    expect(supervisor.reported).toHaveLength(sent);
  });

  it('sends nothing when the counts are unknown, so the supervisor lets the last ones go stale', async () => {
    const supervisor = new FakeSupervisor();
    let known = false;
    const reporter = new BusyReporter(supervisor, async () => (known ? idle : null), quiet, 15);
    reporters.push(reporter);
    reporter.start();
    await wait(60);
    expect(supervisor.reported).toEqual([]);
    known = true;
    await expect.poll(() => supervisor.reported.length).toBeGreaterThan(0);
  });

  it('sends nothing counted while it was being stopped, and never overlaps a slow count', async () => {
    const supervisor = new FakeSupervisor();
    const slow = gate<BusyCounts | null>();
    let counting = 0;
    const reporter = new BusyReporter(
      supervisor,
      () => {
        counting += 1;
        return slow.promise;
      },
      quiet,
      10,
    );
    reporters.push(reporter);
    reporter.start();
    await wait(50); // several intervals pass while the first count is still out
    expect(counting).toBe(1);
    reporter.stop(); // shutdown: the sources are about to be torn down
    slow.resolve(idle);
    await wait(10);
    expect(supervisor.reported).toEqual([]);
  });

  it('says once that the counts are refused, and again when they are taken', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.takesCounts = false;
    const said: string[] = [];
    const log: Logger = { info: (_o, msg) => void said.push(`info:${msg}`), warn: (_o, msg) => void said.push(`warn:${msg}`), error() {} };
    const reporter = new BusyReporter(supervisor, async () => idle, log, 10);
    reporters.push(reporter);
    reporter.start();
    await expect.poll(() => supervisor.reported.length).toBeGreaterThanOrEqual(3);
    supervisor.takesCounts = true;
    await expect.poll(() => said.length).toBe(2);
    await wait(40);
    expect(said).toEqual(['warn:the supervisor did not take the busy counts', 'info:the supervisor is taking busy counts again']);
  });
});
