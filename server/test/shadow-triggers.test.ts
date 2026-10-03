import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { Connectors } from '../src/connectors/service.js';
import { Schedules } from '../src/schedules.js';
import { BRIEF_JOB, Feed, SCOUT_JOB } from '../src/feed/service.js';
import { FeedStore } from '../src/feed/store.js';
import { EventHub } from '../src/hub.js';

const quiet = { info() {}, warn() {} };
const job = { id: 'fake-job', name: 'Signalbox: Demo mail', script: 'wayroost_mail_trigger.py',
  workdir: '/home/me/signalbox-triggers/fake0001', enabled: true, schedule: { expr: '*/15 * * * *' }, deliver: 'local' };

describe('inactive mail triggers', () => {
  function fixture(script = job.script, state = 'scheduled') {
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path === '/api/cron/jobs' ? [{ ...job, script, state }]
      : path === '/api/cron/delivery-targets' ? { targets: [{ id: 'local' }] } : {}));
    const helper = { triggerQueries: vi.fn(async () => ({ fake0001: 'label:fake-demo' })),
      triggerRoles: vi.fn(async () => ({ fake0001: 'shadow' as const })), health: vi.fn(async () => true),
      google: vi.fn(async () => ({ state: 'connected' })), putTrigger: vi.fn(async () => ({ workdir: job.workdir, script, role: 'shadow' as string | undefined })),
      deleteTrigger: vi.fn(async () => {}) };
    const background = new BackgroundGate('primary');
    return { fetch, helper, connectors: new Connectors({ background, dashboard: () => ({ fetch }), dashboardUrl: 'http://127.0.0.1:8892',
      publicOrigin: 'https://wayroost.example.com', helper: helper as never, log: quiet }),
      schedules: new Schedules({ background, dashboard: () => ({ fetch }), triggerRoles: helper.triggerRoles, log: quiet }) };
  }

  it.each(['signalbox_mail_trigger.py', 'wayroost_mail_trigger.py'])('preserves enabled %s shadow specs in both lists and refuses resume/run', async (script) => {
    const { connectors, schedules, fetch } = fixture(script);
    expect((await connectors.triggers()).triggers[0]).toMatchObject({ query: 'label:fake-demo', role: 'shadow', paused: false });
    expect((await schedules.list()).jobs[0]).toMatchObject({ state: 'active', inactiveReason: expect.stringContaining('Pause') });
    await expect(connectors.pauseTrigger('fake-job', false)).rejects.toThrow('recreate');
    await expect(schedules.setPaused('hermes', 'fake-job', false)).rejects.toThrow('recreate');
    await expect(schedules.runNow('hermes', 'fake-job')).rejects.toThrow('recreate');
    expect(fetch.mock.calls.every(([, init]) => !init || (init as RequestInit).method === 'GET')).toBe(true);
    await connectors.pauseTrigger('fake-job', true);
    await schedules.setPaused('hermes', 'fake-job', true);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/pause'))).toHaveLength(2);
  });

  it('preserves running backend state for a legacy shadow trigger and permits pausing', async () => {
    const { schedules, fetch } = fixture('signalbox_mail_trigger.py', 'running');
    expect((await schedules.list()).jobs[0]).toMatchObject({ state: 'running', inactiveReason: expect.stringContaining('Pause') });
    await schedules.setPaused('hermes', 'fake-job', true);
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/pause'))).toBe(true);
  });

  it.each(['shadow', undefined, 'bogus'])('removes the helper folder and refuses to schedule without primary confirmation (%s)', async (role) => {
    const { connectors, helper, fetch } = fixture();
    helper.putTrigger.mockResolvedValue({ workdir: job.workdir, script: job.script, role });
    await expect(connectors.createTrigger({ name: 'Demo mail', query: 'label:fake-demo', action: 'Describe it', every: 15, deliver: 'local' }))
      .rejects.toThrow('helper is in shadow');
    expect(helper.deleteTrigger).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.every(([path]) => path !== '/api/cron/jobs')).toBe(true);
  });

  it('never resumes or runs a trigger when its role lookup fails or omits its spec', async () => {
    const { connectors, schedules, helper, fetch } = fixture();
    helper.triggerRoles.mockResolvedValue({ fake0001: undefined as never });
    await expect(connectors.pauseTrigger('fake-job', false)).rejects.toThrow('recreate');
    await expect(schedules.setPaused('hermes', 'fake-job', false)).rejects.toThrow('recreate');
    await expect(schedules.runNow('hermes', 'fake-job')).rejects.toThrow('recreate');
    helper.triggerRoles.mockRejectedValue(new Error('Role unavailable'));
    await expect(schedules.runNow('hermes', 'fake-job')).rejects.toThrow('role is unknown');
    expect(fetch.mock.calls.every(([, init]) => !init || init.method === 'GET')).toBe(true);
  });

  it('refuses trigger resume/run when the helper role resolver is unavailable', async () => {
    const { fetch } = fixture();
    const schedules = new Schedules({ background: new BackgroundGate('shadow'), dashboard: () => ({ fetch }), log: quiet });
    await expect(schedules.setPaused('hermes', 'fake-job', false)).rejects.toThrow('role is unknown');
    await expect(schedules.runNow('hermes', 'fake-job')).rejects.toThrow('role is unknown');
    expect(fetch.mock.calls.every(([, init]) => !init || init.method === 'GET')).toBe(true);
  });

  it.each([false, true])('keeps ordinary Hermes jobs usable through a helper outage (Paseo: %s)', async (withPaseo) => {
    const ordinary = { ...job, id: 'fake-ordinary', name: 'Demo briefing', script: undefined, prompt: 'Summarize the demo.' };
    const fetch = vi.fn(async (path: string) => Response.json(path === '/api/cron/jobs' ? [ordinary] : {}));
    const triggerRoles = vi.fn(async () => { throw new Error('Helper unavailable'); });
    const schedules = new Schedules({ dashboard: () => ({ fetch }), triggerRoles, log: quiet,
      ...(withPaseo ? { paseo: { schedulesList: async () => [] } as never } : {}) });
    expect((await schedules.list()).jobs).toMatchObject([{ id: ordinary.id, state: 'active' }]);
    await schedules.update('hermes', ordinary.id, { prompt: 'Summarize the other demo.' });
    await schedules.setPaused('hermes', ordinary.id, true);
    await schedules.remove('hermes', ordinary.id);
    expect(triggerRoles).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([path]) => path)).toContain(`/api/cron/jobs/${ordinary.id}`);
  });

  it.each([false, true])('isolates failed ownership lookups to triggers in mixed lists (Paseo: %s)', async (withPaseo) => {
    const ordinary = { ...job, id: 'fake-ordinary', name: 'Demo briefing', script: undefined };
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path === '/api/cron/jobs' ? [job, ordinary] : {}));
    const triggerRoles = vi.fn(async () => { throw new Error('Helper unavailable'); });
    const schedules = new Schedules({ dashboard: () => ({ fetch }), triggerRoles, log: quiet,
      ...(withPaseo ? { paseo: { schedulesList: async () => [] } as never } : {}) });
    const list = await schedules.list();
    expect(list.jobs).toHaveLength(2);
    expect(list.jobs.find((j) => j.id === job.id)).toMatchObject({ state: 'active', inactiveReason: expect.stringContaining('unknown') });
    expect(list.jobs.find((j) => j.id === ordinary.id)).not.toHaveProperty('inactiveReason');
    expect(list.unavailable).toBeUndefined();
    await schedules.update('hermes', ordinary.id, { prompt: 'Demo instructions.' });
    await schedules.remove('hermes', ordinary.id);
    await expect(schedules.setPaused('hermes', job.id, false)).rejects.toThrow('role is unknown');
    await expect(schedules.runNow('hermes', job.id)).rejects.toThrow('role is unknown');
    await schedules.setPaused('hermes', job.id, true);
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/resume') || path.endsWith('/trigger'))).toBe(false);
  });

  it('keeps pulse settings available during a helper outage in a mixed job list', async () => {
    const state = mkdtempSync(join(tmpdir(), 'wayroost-demo-pulse-'));
    try {
      const jobs = [job, ...[BRIEF_JOB, SCOUT_JOB].map((name) => ({ ...job, name, id: `fake-${name}`, script: undefined }))];
      const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path === '/api/cron/jobs' ? jobs : {}));
      const schedules = new Schedules({ dashboard: () => ({ fetch }), log: quiet,
        triggerRoles: async () => { throw new Error('Helper unavailable'); } });
      const feed = new Feed({ store: new FeedStore(state), hub: new EventHub(), schedules, log: quiet,
        hermes: { createConversation: vi.fn() } });
      expect(await feed.updateSettings({ level: 'high' })).toMatchObject({ level: 'high', pulseFound: true });
      expect(fetch.mock.calls.filter(([path]) => path.endsWith('/resume'))).toHaveLength(2);
      expect(fetch.mock.calls.some(([path, init]) => path === `/api/cron/jobs/fake-${SCOUT_JOB}` && init?.method === 'PUT')).toBe(true);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
