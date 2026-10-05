import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { realpathSync, renameSync } from 'node:fs';
import * as sqlite from 'node:sqlite';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { configUnitRunner } from '../src/config-unit.js';
import { cleanupDrain, executeHermesDrain, sweepDrain, type DrainIO, type DrainState } from '../src/drain-runtime.js';
import { cronStoreClear, delegationsClear, gatewayReading, instantiationEpoch, jsonCount, ownerText, processesClear } from '../src/drain-readers.js';
import { fileDrainIO, prepareDrainStorage, publishPrivate } from '../src/drain-files.js';
import { drainUnit, prepareDrainUnit, sweepUnit } from '../src/service-unit.js';
import type { HermesTarget } from '../src/drain-files.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), link: vi.fn(actual.link), unlink: vi.fn(actual.unlink), lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
    const stat = await actual.lstat(...args);
    if (String(args[0]) === '/' && typeof stat.uid === 'number') stat.uid = 0;
    return stat;
  }) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
vi.mock('node:sqlite', async original => {
  const actual = await original<typeof import('node:sqlite')>();
  return { ...actual, DatabaseSync: vi.fn(class extends actual.DatabaseSync {}) };
});
const actualSQLite = await vi.importActual<typeof import('node:sqlite')>('node:sqlite');
const base = Date.parse('2026-01-01T00:00:00Z');
function fake() {
  let time = base;
  let marker: { principal: string; requested_at: string } | null = null;
  let state: DrainState | null = null;
  let stopped = false;
  let restarted = false;
  let active = true;
  const effects: string[] = [];
  const durations: number[] = [];
  const observations: DrainState[] = [];
  const io: DrainIO = {
    now: () => time,
    async sleep(ms) { time += ms; },
    async active(which) { return which === 'gateway' ? active : false; },
    async gateway() {
      return gatewayReading(JSON.stringify({ gateway_state: restarted ? 'running' : marker && time > Date.parse(marker.requested_at) ? 'draining' : 'running', active_agents: 0,
        updated_at: new Date(time).toISOString(), pid: restarted ? 102 : 101,
        start_time: restarted ? 1500 : 1000, active_work: null }));
    },
    async phone() { return true; }, async cron() { return true; }, async background() { return true; },
    async marker() { return marker; },
    async publishMarker(at) { effects.push('marker'); marker = { principal: 'wayroost', requested_at: at }; return true; },
    async removeMarker(at) {
      if (marker?.principal === 'wayroost' && marker.requested_at === at) {
        durations.push(time - Date.parse(at)); effects.push('clear'); marker = null;
      }
    },
    async save(next) { state = structuredClone(next); observations.push(state); },
    async load() { return state; }, async deleteState() { state = null; effects.push('delete-state'); },
    async stop() { expect(state?.stopped_gateway).toBe(true); stopped = true; effects.push('stop'); },
    async start(noBlock) { expect(marker).toBeNull(); restarted = true; stopped = false; effects.push(noBlock ? 'recover-start' : 'start'); },
  };
  return { io, effects, observations, durations, setMarker(value: typeof marker) { marker = value; }, setState(value: DrainState) { state = value; },
    setActive(value: boolean) { active = value; }, get stopped() { return stopped; }, get marker() { return marker; }, get state() { return state; } };
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.mocked(fs.link).mockReset(); });
async function temporary() { const root = await mkdtemp(join(process.cwd(), '.drain-test-')); roots.push(root); return root; }
function target(root = '/home/me'): HermesTarget {
  return { runAs: { user: 'me', uid: process.getuid!() }, gatewayUnit: 'hermes-gateway.service', dashboardUnit: { name: 'dashboard.service', scope: 'user' },
    stateFile: root + '/hermes/gateway_state.json', cronJobs: root + '/hermes/cron/jobs.json', profilesDir: root + '/hermes/profiles',
    processesFile: root + '/hermes/processes.json', stateDatabase: root + '/hermes/state.db', drainStateDir: root + '/drain',
    drainMarker: { path: root + '/hermes/.drain_request.json', runAs: { user: 'me', uid: process.getuid!() } }, phoneHealth: 'http://127.0.0.1:8896/health' };
}

describe('Hermes restart protocol', () => {
  it('requires engagement and two writes, then stops, clears, starts and verifies a new process', async () => {
    const f = fake(); expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' });
    expect(f.effects).toEqual(['marker', 'stop', 'clear', 'start', 'delete-state']);
    expect(f.durations).toEqual([2000]); expect(f.state).toBeNull(); expect(f.stopped).toBe(false);
    expect(f.observations.map(row => row.phase)).toEqual(['waiting', 'draining', 'stopping', 'cleared', 'starting', 'verifying']);
  });
  it('does nothing when the gateway is not running', async () => {
    const f = fake(); f.setActive(false);
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'not_running' }); expect(f.effects).toEqual([]);
  });
  it('waits for a messaging turn without draining', async () => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: f.io.now() < base + 45_000 ? 1 : 0 }) as Awaited<ReturnType<DrainIO['gateway']>>;
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' });
    expect(Date.parse(f.observations.find(row => row.marker_requested_at)?.marker_requested_at!)).toBe(base + 45_000);
  });
  it('holds API or cron work that appears only after the marker', async () => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker && f.io.now() < base + 30_000 ? 1 : 0 });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' }); expect(f.durations).toEqual([31_000]);
  });
  it('keeps incoming gateway turns behind the marker and releases them after restart', async () => {
    const f = fake(); const read = f.io.gateway; const sleep = f.io.sleep;
    const api = () => f.marker || f.stopped ? 503 : 200;
    const messaging = () => f.marker ? 'resend shortly' : 'accepted';
    const refusals: { api: number; messaging: string }[] = [];
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker && f.io.now() < base + 30_000 ? 1 : 0 });
    f.io.sleep = async ms => { await sleep(ms); if (f.marker) refusals.push({ api: api(), messaging: messaging() }); };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' });
    expect(refusals.length).toBeGreaterThan(1); expect(refusals.every(turn => turn.api === 503 && turn.messaging === 'resend shortly')).toBe(true);
    expect(api()).toBe(200); expect(messaging()).toBe('accepted');
  });
  it('lets recurring slots pause during a drain and collapse into one catch-up at start', async () => {
    const f = fake(); const read = f.io.gateway; const sleep = f.io.sleep; const start = f.io.start;
    const dueSlots = [base + 60_000, base + 120_000]; let pending = false; let runs = 0;
    f.io.cron = async () => cronStoreClear([{ enabled: true, schedule: { kind: 'cron', expr: '* * * * *' }, next_run_at: new Date(dueSlots[0] ?? base + 180_000).toISOString() }], f.io.now());
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker && f.io.now() < base + 130_000 ? 1 : 0 });
    f.io.sleep = async ms => {
      await sleep(ms);
      while (dueSlots.length && dueSlots[0]! <= f.io.now()) { dueSlots.shift(); if (f.marker) pending = true; else runs++; }
    };
    f.io.start = async noBlock => { await start(noBlock); if (pending) { pending = false; runs++; } };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' }); expect(runs).toBe(1); expect(dueSlots).toHaveLength(0);
    expect(f.durations).toEqual([131_000]);
  });
  it('releases a long drain at 180 seconds, retries after 600 seconds, then probes an unchanged stale count', async () => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: f.io.now() < base + 1000 || f.marker && f.io.now() >= base + 790_000 ? 0 : 1 });
    const updates: unknown[] = [];
    expect(await executeHermesDrain(f.io, 'idle', patch => updates.push(patch))).toEqual({ outcome: 'restarted' });
    expect(f.durations[0]).toBe(180_000); expect(f.durations.every(ms => ms <= 180_000)).toBe(true);
    expect(updates).toContainEqual(expect.objectContaining({ lastRelease: 'drain-timeout' }));
    expect(updates).toContainEqual(expect.objectContaining({ state: 'probing', probeAttempts: 1 }));
    const times = f.observations.filter(row => row.phase === 'probing').map(row => Date.parse(row.marker_requested_at!));
    expect(times[0]).toBe(base + 780_000);
  });
  it('does not extend a timed-out drain while retrying a transient marker removal failure', async () => {
    const f = fake(); const read = f.io.gateway; const remove = f.io.removeMarker; let fail = true;
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker ? 1 : 0 });
    f.io.removeMarker = async at => { if (fail && f.io.now() >= base + 180_000) { fail = false; throw new Error(); } await remove(at); };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'still_busy' }); expect(f.durations[0]).toBe(180_000);
    expect(f.durations.every(ms => ms <= 180_000)).toBe(true); expect(f.marker).toBeNull();
  });
  it('probes a stale nonzero count after ten minutes and uses the live drain count', async () => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker ? 0 : 1 });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restarted' });
    expect(f.observations).toContainEqual(expect.objectContaining({ phase: 'probing', marker_requested_at: new Date(base + 600_000).toISOString() }));
  });
  it.each(['idle', 'probe'])('immediately releases a chat present at entry during an %s attempt', async kind => {
    const f = fake(); const read = f.io.gateway; let attempts = 0;
    const publish = f.io.publishMarker;
    f.io.publishMarker = async at => { attempts++; return publish(at); };
    f.io.gateway = async () => ({ ...(await read())!, count: kind === 'probe' && !f.marker ? 1 : 0, chat: attempts === 1 && !!f.marker });
    const updates: unknown[] = [];
    expect(await executeHermesDrain(f.io, 'idle', patch => updates.push(patch))).toEqual({ outcome: 'restarted' });
    expect(f.durations[0]).toBe(1000); expect(f.effects.indexOf('clear')).toBeLessThan(f.effects.indexOf('stop'));
    expect(updates).toContainEqual(expect.objectContaining({ lastRelease: 'chat-at-entry' }));
  });
  it('releases the marker at once when a call arrives during a drain', async () => {
    const f = fake(); f.io.phone = async () => f.io.now() < base + 2000 || f.io.now() >= base + 30_000;
    const updates: unknown[] = [];
    expect(await executeHermesDrain(f.io, 'idle', patch => updates.push(patch))).toEqual({ outcome: 'restarted' });
    expect(f.durations[0]).toBe(2000); expect(updates).toContainEqual(expect.objectContaining({ lastRelease: 'call-started' }));
  });
  it.each(['phone', 'cron', 'background'] as const)('keeps waiting without a marker when %s is unreadable or busy', async name => {
    const f = fake(); f.io[name] = async () => false;
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'still_busy' });
    expect(f.effects).toEqual(['delete-state']); expect(f.io.now()).toBe(base + 7_200_000);
  });
  it.each([
    { body: '{"active_calls":1}', status: 200, busy: 'call' },
    { body: '{"active_calls":1}', status: 503, busy: 'call' },
    { body: '{"active_calls":2}', status: 503, busy: 'call' },
    { body: '{}', status: 503, busy: 'phone-unavailable' },
    { body: '{"active_calls":"1"}', status: 503, busy: 'phone-unavailable' },
    { body: '{', status: 503, busy: 'phone-unavailable' },
    { body: null, status: 503, busy: 'phone-unavailable' },
  ])('reports $busy while waiting for phone health at HTTP $status with $body', async ({ body, status, busy }) => {
    const f = fake(); const request = vi.fn(async () => {
      if (body === null) throw new Error();
      return new Response(body, { status });
    });
    const phone = fileDrainIO(target(), vi.fn(), request as unknown as typeof fetch);
    f.io.phone = phone.phone; f.io.phoneReleaseReason = phone.phoneReleaseReason;
    const updates: string[][] = [];
    expect(await executeHermesDrain(f.io, 'idle', patch => updates.push(patch.busy!))).toEqual({ outcome: 'still_busy' });
    expect(updates.length).toBeGreaterThan(0); expect(new Set(updates.map(reasons => reasons.join(',')))).toEqual(new Set([busy]));
    expect(f.effects).toEqual(['delete-state']);
  });
  it('does not trust a missing count for either idle or a stale-count probe', async () => {
    const f = fake(); const read = f.io.gateway; f.io.gateway = async () => ({ ...(await read())!, count: undefined });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'still_busy' }); expect(f.effects).toEqual(['delete-state']);
  });
  it('fails an ignored marker or hung gateway within five seconds', async () => {
    const f = fake(); const read = f.io.gateway; f.io.gateway = async () => ({ ...(await read())!, state: 'running' });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'drain_not_engaged' }); expect(f.durations).toEqual([5000]);
  });
  it('observes engagement within five seconds while the phone health request takes nine seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(base);
    try {
      const f = fake(); const engaged: number[] = [];
      f.io.now = Date.now; f.io.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      f.io.phone = async () => { if (f.marker) await new Promise(resolve => setTimeout(resolve, 9000)); return true; };
      f.io.gateway = async () => {
        const draining = f.marker && Date.now() > Date.parse(f.marker.requested_at);
        if (draining) engaged.push(Date.now());
        const restarted = f.effects.includes('start');
        return { state: restarted ? 'running' : draining ? 'draining' : 'running', count: 0,
          updatedAt: new Date().toISOString(), pid: restarted ? 102 : 101, startTime: restarted ? 1500 : 1000, chat: false, workKnown: true };
      };
      const pending = executeHermesDrain(f.io);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await pending).toEqual({ outcome: 'restarted' }); expect(engaged[0]).toBe(base + 1000);
    } finally { vi.useRealTimers(); }
  });
  it('a frozen timestamp cannot establish idle', async () => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, updatedAt: new Date(f.marker ? Date.parse(f.marker.requested_at) + 1000 : f.io.now()).toISOString() });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'still_busy' });
    expect(f.effects).not.toContain('stop'); expect(f.durations.every(ms => ms <= 180_000)).toBe(true);
  });
  it.each(['gone', 'principal', 'timestamp'])('reports lost marker ownership for a marker that is %s', async kind => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => {
      if (f.marker && f.io.now() >= base + 1000) f.setMarker(kind === 'gone' ? null : { ...f.marker, ...(kind === 'principal' ? { principal: 'someone-else' } : { requested_at: new Date(base + 500).toISOString() }) });
      return read();
    };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'marker_lost' }); expect(f.effects).not.toContain('stop');
    if (kind !== 'gone') expect(f.marker).not.toBeNull();
  });
  it('keeps a foreign marker and handles an exclusive publication collision', async () => {
    const f = fake(); f.setMarker({ principal: 'other', requested_at: new Date(base).toISOString() });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'foreign_drain' }); expect(f.marker?.principal).toBe('other');
    const g = fake(); g.io.publishMarker = async () => false;
    expect(await executeHermesDrain(g.io)).toEqual({ outcome: 'foreign_drain' }); expect(g.effects).not.toContain('stop');
  });
  it('reports a restart whose new process cannot be verified', async () => {
    const f = fake(); const start = f.io.start; f.io.start = async noBlock => { await start(noBlock); f.io.gateway = async () => undefined; };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restart_unverified' }); expect(f.marker).toBeNull(); expect(f.state).toBeNull();
  });
  it('immediate restart has the same stop intent and recovery but does not drain', async () => {
    const f = fake(); expect(await executeHermesDrain(f.io, 'now')).toEqual({ outcome: 'restarted' }); expect(f.effects).not.toContain('marker');
  });
});

describe('interrupted executor cleanup', () => {
  it.each(['draining', 'stopping', 'cleared', 'starting'] as const)('recovers a killed or timed-out executor in %s', async phase => {
    const f = fake(); const at = new Date(base).toISOString();
    f.setState({ phase, marker_requested_at: at, stopped_gateway: phase !== 'draining', started_gateway: false });
    if (phase === 'draining' || phase === 'stopping') f.setMarker({ principal: 'wayroost', requested_at: at });
    await cleanupDrain(f.io);
    expect(f.marker).toBeNull(); expect(f.state).toBeNull(); expect(f.stopped).toBe(false);
    expect(f.effects).toEqual([...(phase === 'draining' || phase === 'stopping' ? ['clear'] : []), ...(phase !== 'draining' ? ['recover-start'] : []), 'delete-state']);
    await cleanupDrain(f.io);
  });
  it('preserves a replacement marker after the stop and still restores the gateway', async () => {
    const f = fake(); const stop = f.io.stop; const start = f.io.start;
    const foreign = { principal: 'other', requested_at: new Date(base + 500).toISOString() };
    f.io.stop = async timeout => { await stop(timeout); f.setMarker(foreign); };
    f.io.start = async noBlock => {
      expect(f.marker).toEqual(foreign); f.setMarker(null); await start(noBlock); f.setMarker(foreign);
    };
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'marker_lost' });
    expect(f.marker).toEqual(foreign); expect(f.stopped).toBe(false); expect(f.state).toBeNull(); expect(f.effects).toContain('recover-start');
  });
  it('retries marker removal before it starts the gateway', async () => {
    const f = fake(); const at = new Date(base).toISOString();
    f.setState({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false }); f.setMarker({ principal: 'wayroost', requested_at: at });
    const remove = f.io.removeMarker; let fail = true;
    f.io.removeMarker = async at => { if (fail) { fail = false; throw new Error(); } await remove(at); };
    await cleanupDrain(f.io); expect(f.effects).toEqual(['clear', 'recover-start', 'delete-state']);
  });
  it('retries a transient recovery error while the owned marker remains', async () => {
    const f = fake(); const at = new Date(base).toISOString(); const remove = f.io.removeMarker;
    f.setState({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    f.setMarker({ principal: 'wayroost', requested_at: at });
    const recover = vi.fn(async () => { if (recover.mock.calls.length <= 2) throw Object.assign(new Error(), { code: 'EIO' }); });
    f.io.recoverMarkers = recover;
    f.io.removeMarker = async at => { await recover(); await remove(at); };
    await cleanupDrain(f.io);
    expect(recover.mock.calls.length).toBeGreaterThan(2); expect(f.effects).toEqual(['clear', 'recover-start', 'delete-state']);
  });
  it.each(['removal', 'recovery'])('retains a stopped gateway and its state while marker %s keeps failing', async failure => {
    const f = fake(); const at = new Date(base).toISOString(); const remove = f.io.removeMarker;
    const error = Object.assign(new Error(), { code: 'EIO' }); const start = vi.fn(f.io.start);
    f.io.start = start;
    f.setState({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    await f.io.stop(); f.effects.length = 0;
    f.setMarker({ principal: 'wayroost', requested_at: at });
    const recover = vi.fn(async () => { if (failure === 'recovery') throw error; }); f.io.recoverMarkers = recover;
    const failingRemove = vi.fn(async (at: unknown) => { await recover(); if (failure === 'removal') throw error; await remove(at); });
    f.io.removeMarker = failingRemove;
    await expect(cleanupDrain(f.io)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled(); expect(f.marker).toEqual({ principal: 'wayroost', requested_at: at });
    expect(f.stopped).toBe(true);
    expect(f.state).toMatchObject({ stopped_gateway: true, started_gateway: false }); expect(f.effects).not.toContain('delete-state');
    expect(failingRemove.mock.calls.length).toBeGreaterThan(1); expect(failingRemove.mock.calls.length).toBeLessThanOrEqual(150);
    expect(f.io.now() - base).toBeLessThanOrEqual(150_000);
    f.io.recoverMarkers = async () => {}; f.io.removeMarker = remove;
    await cleanupDrain(f.io); expect(f.effects).toEqual(['clear', 'recover-start', 'delete-state']); expect(f.state).toBeNull(); expect(f.stopped).toBe(false);
  });
  it.each(['unreadable', 'unknown'])('withholds recovery start when the public marker is %s', async failure => {
    const f = fake(); const at = new Date(base).toISOString(); const marker = f.io.marker; const start = vi.fn(f.io.start);
    f.setState({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    f.setMarker({ principal: 'wayroost', requested_at: at }); f.io.start = start;
    f.io.marker = async () => { if (failure === 'unreadable') throw Object.assign(new Error(), { code: 'EIO' }); return {}; };
    await expect(cleanupDrain(f.io)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled(); expect(f.state).toMatchObject({ stopped_gateway: true, started_gateway: false });
    f.io.marker = marker; await cleanupDrain(f.io); expect(f.state).toBeNull();
  });
  it.each(['stop', 'start'] as const)('recovers after a failed %s without reporting success', async name => {
    const f = fake(); let fail = true;
    if (name === 'start') {
      const original = f.io.start;
      f.io.start = async noBlock => { if (fail) { fail = false; throw new Error(); } await original(noBlock); };
    } else {
      const original = f.io.stop;
      f.io.stop = async timeout => { if (fail) { fail = false; throw new Error(); } await original(timeout); };
    }
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'restart_unverified' });
    expect(f.effects).toContain('recover-start'); expect(f.marker).toBeNull(); expect(f.state).toBeNull();
  });
  it('sweeps only an orphaned Wayroost marker, and preserves an active executor', async () => {
    const f = fake(); const at = new Date(base).toISOString(); f.setMarker({ principal: 'wayroost', requested_at: at });
    f.io.active = async () => true; await sweepDrain(f.io); expect(f.marker).not.toBeNull();
    f.io.active = async () => false; await sweepDrain(f.io); expect(f.marker).toBeNull();
    f.setMarker({ principal: 'other', requested_at: at }); await sweepDrain(f.io); expect(f.marker?.principal).toBe('other');
  });
});

describe('safe observations', () => {
  it.each(['{}', '{"active_agents":null}', '{"active_agents":"0"}', '{"active_agents":"1"}', '{"active_agents":0.0}', '{"active_agents":true}',
    '{"active_agents":false}', '{"active_agents":-1}', '{"active_agents":[]}', '{"active_agents":{}}', '[]', '{', '', '{"active_agents":0e0}'])('fails closed for %s', source => {
    expect(jsonCount(source, 'active_agents')).toBeUndefined();
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: jsonCount(source, 'active_agents') });
    return executeHermesDrain(f.io).then(result => { expect(result).toEqual({ outcome: 'still_busy' }); expect(f.effects).not.toContain('marker'); });
  });
  it.each(['{}', '{"active_agents":null}', '{"active_agents":"0"}', '{"active_agents":"1"}', '{"active_agents":0.0}', '{"active_agents":true}',
    '{"active_agents":false}', '{"active_agents":-1}', '{"active_agents":[]}', '{"active_agents":{}}', '[]', '{', '', '{"active_agents":0e0}'])('never accepts malformed drain-idle count %s', async source => {
    const f = fake(); const read = f.io.gateway;
    f.io.gateway = async () => ({ ...(await read())!, count: f.marker ? jsonCount(source, 'active_agents') : 0 });
    expect(await executeHermesDrain(f.io)).toEqual({ outcome: 'still_busy' }); expect(f.effects).not.toContain('stop');
    expect(f.durations.every(ms => ms <= 180_000)).toBe(true); expect(f.marker).toBeNull();
  });
  it('a missing gateway file fails closed', async () => {
    const root = await temporary(); const io = fileDrainIO(target(root), vi.fn());
    expect(await io.gateway()).toBeUndefined();
  });
  it('validates only the root count and timestamps with offsets', () => {
    expect(jsonCount('{"nested":{"active_agents":0},"active_agents":1}', 'active_agents')).toBe(1);
    expect(jsonCount('{"active_agents":0,"nested":{"active_agents":1}}', 'active_agents')).toBe(0);
    expect(gatewayReading('{"gateway_state":"running","active_agents":0,"updated_at":"2026-01-01T00:00:00"}')).toBeUndefined();
  });
  it('accepts null work only with a valid zero count and reads numeric start fingerprints', () => {
    const entry = { gateway_state: 'draining', updated_at: new Date(base).toISOString(), active_work: null, active_agents: 0, pid: 101, start_time: 12345 };
    expect(gatewayReading(JSON.stringify(entry))).toMatchObject({ count: 0, workKnown: true, chat: false, startTime: 12345 });
    for (const active_agents of [undefined, null, '0', 1, -1]) {
      expect(gatewayReading(JSON.stringify({ ...entry, active_agents }))?.workKnown).toBe(false);
    }
    for (const active_work of [undefined, {}, false, [null], [{ kind: 0 }]]) {
      expect(gatewayReading(JSON.stringify({ ...entry, active_work }))?.workKnown).toBe(false);
    }
    for (const start_time of [undefined, null, '12345', new Date(base).toISOString(), -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(gatewayReading(JSON.stringify({ ...entry, start_time }))?.startTime).toBeUndefined();
    }
    expect(gatewayReading(JSON.stringify({ ...entry, active_work: [{ kind: 'chat' }], active_agents: 1 }))?.chat).toBe(true);
  });
  it('keeps a failed one-shot busy after it is enabled and scheduled again', () => {
    const job = { enabled: true, schedule: { kind: 'once' }, last_status: 'error', next_run_at: new Date(base + 1000).toISOString() };
    expect(cronStoreClear([job], base)).toBe(false);
    expect(cronStoreClear([{ ...job, enabled: false }], base)).toBe(true);
    expect(cronStoreClear([{ ...job, next_run_at: new Date(base + 301_000).toISOString() }], base)).toBe(true);
  });
  it('holds fresh fire and run claims for all jobs, including profiles and disabled jobs', () => {
    const job = { enabled: false, schedule: { kind: 'cron' }, next_run_at: new Date(base + 1000).toISOString() };
    for (const claim of ['fire_claim', 'run_claim']) {
      expect(cronStoreClear({ jobs: [{ ...job, [claim]: { at: new Date(base - 299_000).toISOString() } }] }, base)).toBe(false);
      expect(cronStoreClear([{ ...job, [claim]: { at: new Date(base - 300_000).toISOString() } }], base)).toBe(true);
      expect(cronStoreClear([{ ...job, [claim]: { at: new Date(base + 60_000).toISOString() } }], base)).toBe(false);
      expect(cronStoreClear([{ ...job, [claim]: { at: 'bad' } }], base)).toBe(false);
    }
  });
  it('applies the due window to runnable one-shots, including overdue ones, and lets recurring jobs catch up', () => {
    const job = { enabled: true, schedule: { kind: 'once' }, next_run_at: new Date(base + 300_000).toISOString() };
    expect(cronStoreClear([job], base)).toBe(false);
    expect(cronStoreClear([{ ...job, next_run_at: new Date(base - 1000).toISOString() }], base)).toBe(false);
    expect(cronStoreClear([{ ...job, next_run_at: new Date(base + 301_000).toISOString() }], base)).toBe(true);
    expect(cronStoreClear([{ ...job, schedule: { kind: 'cron', expr: '*/2 * * * *' } }], base)).toBe(true);
    for (const state of ['paused', 'completed', 'error']) expect(cronStoreClear([{ ...job, state }], base)).toBe(true);
    expect(cronStoreClear([{ ...job, paused_at: new Date(base).toISOString() }], base)).toBe(true);
  });
  it('holds live host jobs, non-host jobs and malformed process entries', () => {
    const alive = vi.fn(() => false);
    expect(processesClear([], alive)).toBe(true); expect(alive).not.toHaveBeenCalled();
    expect(processesClear([{ pid: 100, pid_scope: 'host' }], () => true)).toBe(false);
    expect(processesClear([{ pid: 100, pid_scope: 'host' }], alive)).toBe(true); expect(alive).toHaveBeenCalledWith(100);
    for (const value of [null, {}, { processes: [] }, [null], [{ pid: '100', pid_scope: 'host' }], [{ pid: -1, pid_scope: 'host' }],
      [{ pid: 100, backend: 'host' }], [{ pid: 100, pid_scope: 'container' }]]) expect(processesClear(value, alive)).toBe(false);
  });
  it('computes the Hermes epoch from boot id and PID 1 field 22', () => {
    const fields = ['S', ...Array(18).fill('0'), '12345', '999'];
    expect(instantiationEpoch('11111111-2222-3333-4444-555555555555\n', '1 (a name (with spaces)) ' + fields.join(' ')))
      .toBe('11111111-2222-3333-4444-555555555555:12345');
  });
  it('reads only owned regular bounded files without links', async () => {
    const root = await temporary(); const file = join(root, 'value.json'); await writeFile(file, '{}');
    expect(await ownerText(file, process.getuid!())).toBe('{}');
    await expect(ownerText(file, process.getuid!() + 1)).rejects.toThrow(); await expect(ownerText(file, process.getuid!(), 1)).rejects.toThrow();
    await symlink(file, join(root, 'link')); await expect(ownerText(join(root, 'link'), process.getuid!())).rejects.toThrow();
    await symlink(root, join(root, 'directory-link')); await expect(ownerText(join(root, 'directory-link/value.json'), process.getuid!())).rejects.toThrow();
    await expect(ownerText(root, process.getuid!())).rejects.toThrow();
  });
  it('reads running delegations through a read-only SQLite connection', async () => {
    const root = await temporary(); const path = join(root, 'state.db'); const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path); db.exec('CREATE TABLE async_delegations (state TEXT)'); db.close();
    expect(await delegationsClear(path, process.getuid!())).toBe(true);
    const writer = new DatabaseSync(path); writer.exec("INSERT INTO async_delegations VALUES ('running')"); writer.close();
    const before = await readFile(path); expect(await delegationsClear(path, process.getuid!())).toBe(false); expect(await readFile(path)).toEqual(before);
    await symlink(path, join(root, 'db-link')); expect(await delegationsClear(join(root, 'db-link'), process.getuid!())).toBe(false);
  });
  it('refuses a database replaced after descriptor checks but before SQLite reopens it', async () => {
    const root = await temporary(); const path = join(root, 'state.db'); const replacement = join(root, 'replacement.db');
    for (const filename of [path, replacement]) {
      const db = new actualSQLite.DatabaseSync(filename); db.exec('CREATE TABLE async_delegations (state TEXT)');
      if (filename === path) db.exec("INSERT INTO async_delegations VALUES ('running')");
      db.close();
    }
    vi.mocked(sqlite.DatabaseSync).mockImplementationOnce(class extends actualSQLite.DatabaseSync {
      constructor(location: string | Buffer | URL, options?: sqlite.DatabaseSyncOptions) {
        const resolved = realpathSync(location); renameSync(replacement, path); super(resolved, options);
      }
    });
    expect(await delegationsClear(path, process.getuid!())).toBe(false);
  });
  it.each(['open', 'query', 'open-and-restore'])('refuses an ancestor replaced during SQLite %s even when pinned files stay unchanged', async when => {
    const root = await temporary(); const ancestor = join(root, 'ancestor'); const replacement = join(root, 'replacement');
    const path = join(ancestor, 'nested/state.db');
    for (const folder of [ancestor, replacement]) {
      await mkdir(join(folder, 'nested'), { recursive: true });
      const db = new actualSQLite.DatabaseSync(join(folder, 'nested/state.db'));
      db.exec('CREATE TABLE async_delegations (state TEXT)');
      if (folder === (when === 'query' ? replacement : ancestor)) db.exec("INSERT INTO async_delegations VALUES ('running')");
      db.close();
    }
    const replace = () => { renameSync(ancestor, join(root, 'saved')); renameSync(replacement, ancestor); };
    vi.mocked(sqlite.DatabaseSync).mockImplementationOnce(class extends actualSQLite.DatabaseSync {
      constructor(location: string | Buffer | URL, options?: sqlite.DatabaseSyncOptions) {
        const resolved = realpathSync(location);
        if (when !== 'query') replace();
        super(resolved, options);
        if (when === 'open-and-restore') { renameSync(ancestor, replacement); renameSync(join(root, 'saved'), ancestor); }
        if (when === 'query') {
          const database: sqlite.DatabaseSync = this; const prepare = database.prepare.bind(database);
          vi.spyOn(database, 'prepare').mockImplementation(sql => {
            const statement = prepare(sql);
            if (sql.startsWith('SELECT')) {
              const get = statement.get.bind(statement);
              vi.spyOn(statement, 'get').mockImplementation(() => { const row = get(); replace(); return row; });
            }
            return statement;
          });
        }
      }
    });
    expect(await delegationsClear(path, process.getuid!())).toBe(false);
    const original = new actualSQLite.DatabaseSync(when === 'open-and-restore' ? path : join(root, 'saved/nested/state.db'), { readOnly: true });
    try { expect(!!original.prepare("SELECT 1 FROM async_delegations WHERE state = 'running'").get()).toBe(when !== 'query'); }
    finally { original.close(); }
  });
  it('reads uncheckpointed WAL rows and checks sidecar ownership and links', async () => {
    const root = await temporary(); const path = join(root, 'state.db'); const db = new actualSQLite.DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE async_delegations (state TEXT); INSERT INTO async_delegations VALUES ('running')");
      expect(await delegationsClear(path, process.getuid!())).toBe(false);
      db.exec('DELETE FROM async_delegations');
      expect(await delegationsClear(path, process.getuid!())).toBe(true);
      const before = await readFile(path + '-wal');
      const open = vi.mocked(fs.open).getMockImplementation()!;
      vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
        const file = await open(...args);
        if (String(args[0]).endsWith('-wal')) {
          const stat = file.stat.bind(file);
          vi.spyOn(file, 'stat').mockImplementation(async options => {
            const value = await stat(options); value.uid = typeof value.uid === 'bigint' ? BigInt(process.getuid!() + 1) : process.getuid!() + 1; return value;
          });
        }
        return file;
      });
      expect(await delegationsClear(path, process.getuid!())).toBe(false); expect(await readFile(path + '-wal')).toEqual(before);
      vi.mocked(fs.open).mockImplementation(open);
      await rename(path + '-wal', path + '-saved-wal'); await symlink(path + '-saved-wal', path + '-wal');
      expect(await delegationsClear(path, process.getuid!())).toBe(false);
    } finally { db.close(); }
  });
  it.each(['-wal', '-shm'])('refuses a %s replacement during SQLite opening', async suffix => {
    const root = await temporary(); const path = join(root, 'state.db'); const db = new actualSQLite.DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE async_delegations (state TEXT)');
      const replacement = path + '-replacement'; await writeFile(replacement, await readFile(path + suffix));
      vi.mocked(sqlite.DatabaseSync).mockImplementationOnce(class extends actualSQLite.DatabaseSync {
        constructor(location: string | Buffer | URL, options?: sqlite.DatabaseSyncOptions) {
          renameSync(replacement, path + suffix); super(location, options);
        }
      });
      expect(await delegationsClear(path, process.getuid!())).toBe(false);
    } finally { db.close(); }
  });
  it('refuses a database replaced while its idle query is running', async () => {
    const root = await temporary(); const path = join(root, 'state.db'); const replacement = join(root, 'replacement.db');
    for (const filename of [path, replacement]) {
      const db = new actualSQLite.DatabaseSync(filename); db.exec('CREATE TABLE async_delegations (state TEXT)'); db.close();
    }
    vi.mocked(sqlite.DatabaseSync).mockImplementationOnce(class extends actualSQLite.DatabaseSync {
      constructor(location: string | Buffer | URL, options?: sqlite.DatabaseSyncOptions) {
        super(location, options); const database: sqlite.DatabaseSync = this; const prepare = database.prepare.bind(database);
        vi.spyOn(database, 'prepare').mockImplementation(sql => {
          const statement = prepare(sql);
          if (sql.startsWith('SELECT')) {
            const get = statement.get.bind(statement);
            vi.spyOn(statement, 'get').mockImplementation(() => { const row = get(); renameSync(replacement, path); return row; });
          }
          return statement;
        });
      }
    });
    expect(await delegationsClear(path, process.getuid!())).toBe(false);
  });
  it('refuses a WAL database with no shared index without creating it', async () => {
    const root = await temporary(); const path = join(root, 'state.db'); const db = new actualSQLite.DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE async_delegations (state TEXT)');
      await rename(path + '-shm', path + '-saved-shm');
      expect(await delegationsClear(path, process.getuid!())).toBe(false);
      await expect(lstat(path + '-shm')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { db.close(); }
  });
});

describe('unit boundary', () => {
  it('validates existing private storage without launching a preparation unit', async () => {
    const root = await temporary(); const hermes = target(root);
    await prepareDrainStorage(hermes); expect(await prepareDrainUnit(hermes)).toBeUndefined();
  });
  it.each(['symlink', 'exposed', 'foreign-owner', 'root-owner', 'file', 'unsafe-ancestor'])('refuses %s storage before preparing a unit or writing as the owner', async kind => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    if (kind === 'symlink') {
      await mkdir(join(root, 'other'), { mode: 0o700 }); await symlink(join(root, 'other'), hermes.drainStateDir);
    } else if (kind === 'file') await writeFile(hermes.drainStateDir, 'unchanged', { mode: 0o600 });
    else if (kind === 'unsafe-ancestor') {
      const parent = join(root, 'exposed'); await mkdir(parent, { mode: 0o777 }); await chmod(parent, 0o777);
      hermes.drainStateDir = join(parent, 'drain');
    } else {
      await mkdir(hermes.drainStateDir, { mode: kind === 'exposed' ? 0o755 : 0o700 });
      if (kind === 'foreign-owner' || kind === 'root-owner') vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof actual.lstat>) => {
        const stat = await actual.lstat(...args);
        if (String(args[0]) === hermes.drainStateDir) stat.uid = kind === 'root-owner' ? 0 : process.getuid!() + 1;
        if (String(args[0]) === '/') stat.uid = 0;
        return stat;
      });
    }
    await expect(prepareDrainUnit(hermes)).rejects.toMatchObject({ code: 'unsafe_directory' });
    await expect(prepareDrainStorage(hermes)).rejects.toMatchObject({ code: 'unsafe_directory' });
    expect(await readdir(join(root, 'hermes'))).toEqual([]);
  });
  it('refuses preparing storage as another owner', async () => {
    const root = await temporary(); const hermes = target(root); hermes.runAs.uid++; hermes.drainMarker.runAs.uid++;
    await expect(prepareDrainStorage(hermes)).rejects.toMatchObject({ code: 'unsafe_directory' });
    expect(await readdir(root)).toEqual([]);
  });
  it('runs with owner identity, real loopback, bounded runtime and owner cleanup', () => {
    const hermes = target(); const unit = drainUnit(hermes, 'idle', '/opt/example/node', '/opt/example/service-entry.js');
    expect(unit.argv).toEqual(expect.arrayContaining(['--unit=wayroost-drain-hermes-gateway', '--uid=' + hermes.runAs.uid,
      '--property=RuntimeMaxSec=8100', '--property=TimeoutStopSec=150', '--property=NoNewPrivileges=yes',
      '--property=IPAddressDeny=any', '--property=IPAddressAllow=localhost', '--property=ReadWritePaths="/home/me/hermes" "/home/me/drain"']));
    expect(unit.argv.some(arg => arg.includes('PrivateNetwork=yes') || arg.includes('ProtectProc=') || arg.includes('runuser'))).toBe(false);
    expect(unit.argv.find(arg => arg.startsWith('--property=ExecStopPost='))).toContain('"/opt/example/node" "/opt/example/service-entry.js" "cleanup"');
    expect(sweepUnit(hermes).argv).toContain('--uid=' + hermes.drainMarker.runAs.uid);
  });
  it.each([200, 503, 404, 500])('reads the phone body at HTTP %i and connects only to loopback without redirects', async status => {
    const request = vi.fn(async () => new Response('{"active_calls":0}', { status })); const io = fileDrainIO(target(), vi.fn(), request as unknown as typeof fetch);
    expect(await io.phone(12_000)).toBe(true); expect(request.mock.calls[0]).toMatchObject([expect.any(URL), { redirect: 'error', signal: expect.any(AbortSignal) }]);
  });
  it.each(['{"active_calls":1}', '{"active_calls":2}', '{}', '{"active_calls":"0"}', '{"active_calls":true}', '{"active_calls":-1}', '{"active_calls":null}', '{'])('fails closed for phone body %s', async body => {
    const request = vi.fn(async () => new Response(body, { status: 503 })); expect(await fileDrainIO(target(), vi.fn(), request as unknown as typeof fetch).phone(12_000)).toBe(false);
  });
  it('uses systemctl --user with only the runtime directory and no privilege helper', async () => {
    const command = vi.fn(async () => ({ code: 0, stdout: 'active\n' })); const hermes = target(); const io = fileDrainIO(hermes, command);
    expect(await io.active('gateway')).toBe(true); await io.stop(); await io.start(); await io.start(true);
    expect(command.mock.calls).toEqual([
      [['systemctl', '--user', 'is-active', 'hermes-gateway.service'], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 5000],
      [['systemctl', '--user', 'stop', 'hermes-gateway.service'], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000],
      [['systemctl', '--user', 'start', 'hermes-gateway.service'], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000],
      [['systemctl', '--user', '--no-block', 'start', 'hermes-gateway.service'], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000],
    ]);
  });
  it('keeps the unit client alive beyond the short config-unit deadline', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
      const launch = vi.fn(() => child);
      const unit = drainUnit(target(), 'idle', '/opt/example/node', '/opt/example/service-entry.js');
      const pending = configUnitRunner(async path => path, launch as unknown as typeof spawn)(unit);
      await vi.advanceTimersByTimeAsync(40_001); expect(launch).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
      child.stdout.write('{"outcome":"still_busy"}\n'); child.stdout.end(); child.emit('close', 0);
      expect(await pending).toEqual({ code: 0, stdout: '{"outcome":"still_busy"}\n' });
    } finally { vi.useRealTimers(); }
  });
  it('streams long-running progress without retaining it and accepts a final line without a newline', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    const launch = vi.fn(() => child); const onLine = vi.fn((line: string) => line.startsWith('{"progress":'));
    const pending = configUnitRunner(async path => path, launch as unknown as typeof spawn)(drainUnit(target(), 'idle'), onLine);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const progress = '{"progress":{"state":"waiting","busy":["agents-running"]}}\n';
    child.stdout.write(progress.slice(0, 10)); child.stdout.write(progress.slice(10) + progress.repeat(20_000));
    child.stdout.end('{"outcome":"still_busy"}'); child.emit('close', 0);
    expect(await pending).toEqual({ code: 0, stdout: '{"outcome":"still_busy"}' });
    expect(onLine).toHaveBeenCalledTimes(20_002); expect(child.kill).not.toHaveBeenCalled();
  });
  it('writes the exact marker and durable state as the owner, then recovers from stop intent', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const command = vi.fn(async () => ({ code: 0, stdout: '' })); const epoch = '11111111-2222-3333-4444-555555555555:12345';
    const io = fileDrainIO(hermes, command, fetch, async () => epoch); const at = new Date(base).toISOString();
    await io.save({ phase: 'draining', marker_requested_at: at, stopped_gateway: false, started_gateway: false });
    expect((await lstat(join(hermes.drainStateDir, 'hermes-gateway.json'))).mode & 0o777).toBe(0o600);
    expect(await io.publishMarker(at)).toBe(true);
    expect((await lstat(hermes.drainMarker.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(hermes.drainMarker.path, 'utf8'))).toEqual({ action: 'drain', requested_at: at, principal: 'wayroost', epoch, suppress_notification: true });
    expect(await io.publishMarker(new Date(base + 1000).toISOString())).toBe(false);
    await io.removeMarker(new Date(base + 1000).toISOString()); expect(await io.marker()).not.toBeNull();
    await io.save({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    await cleanupDrain(io); expect(await io.marker()).toBeNull(); expect(await io.load()).toBeNull();
    expect(command.mock.calls).toEqual([[['systemctl', '--user', '--no-block', 'start', 'hermes-gateway.service'], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000]]);
  });
  it('publishes an exclusive 0600 marker without overwriting one already present', async () => {
    const root = await temporary(); const file = join(root, '.drain_request.json'); await publishPrivate(file, { principal: 'wayroost' }, true);
    await expect(publishPrivate(file, { principal: 'other' }, true)).rejects.toThrow(); expect(JSON.parse(await readFile(file, 'utf8')).principal).toBe('wayroost');
  });
  it.each(['other-principal', 'other-request', 'invalid'])('preserves a %s marker substituted between validation and capture', async kind => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); expect(await io.publishMarker(at)).toBe(true);
    const foreign = kind === 'invalid' ? '{' : JSON.stringify({ principal: kind === 'other-principal' ? 'other' : 'wayroost', requested_at: new Date(base + 1000).toISOString() });
    vi.mocked(fs.unlink).mockImplementationOnce(async path => {
      if (String(path) === hermes.drainMarker.path) {
        await writeFile(hermes.drainMarker.path + '.replacement', foreign);
        await actual.rename(hermes.drainMarker.path + '.replacement', hermes.drainMarker.path);
      }
      await actual.unlink(path);
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await writeFile(hermes.drainMarker.path + '.replacement', foreign);
      await actual.rename(hermes.drainMarker.path + '.replacement', hermes.drainMarker.path);
      await actual.rename(from, to);
    });
    await io.removeMarker(at);
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it('keeps a marker published after capture while it removes only the captured owner marker', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); expect(await io.publishMarker(at)).toBe(true);
    const foreign = JSON.stringify({ principal: 'other', requested_at: at });
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { await actual.rename(from, to); await writeFile(hermes.drainMarker.path, foreign); });
    await io.removeMarker(at); expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
  });
  it('preserves both foreign markers when restoration meets another publication', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); expect(await io.publishMarker(at)).toBe(true);
    const foreign = JSON.stringify({ principal: 'other', requested_at: at });
    const newer = JSON.stringify({ principal: 'newer', requested_at: at });
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await writeFile(hermes.drainMarker.path, foreign); await actual.rename(from, to); await writeFile(hermes.drainMarker.path, newer);
    });
    await expect(io.removeMarker(at)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(newer);
    const staging = (await readdir(join(root, 'hermes'))).find(name => name.startsWith('.wayroost-'))!;
    expect(await readFile(join(root, 'hermes', staging, 'marker'), 'utf8')).toBe(foreign);
    await expect(cleanupDrain(fileDrainIO(hermes, vi.fn()))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(newer);
    await actual.unlink(hermes.drainMarker.path);
    await sweepDrain(fileDrainIO(hermes, async () => ({ code: 3, stdout: 'inactive\n' })));
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it.each(['cleanup', 'sweep'])('starts a stopped gateway despite a foreign restoration collision through %s', async recovery => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const at = new Date(base).toISOString();
    const foreign = JSON.stringify({ principal: 'other', requested_at: at });
    const newer = JSON.stringify({ principal: 'newer', requested_at: at });
    let stopped = false;
    const command = vi.fn(async (argv: readonly string[]) => {
      if (argv.includes('is-active')) return { code: 3, stdout: 'inactive\n' };
      if (argv.includes('stop')) { stopped = true; return { code: 0, stdout: '' }; }
      expect(stopped).toBe(true); stopped = false;
      expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(newer);
      return { code: 0, stdout: '' };
    });
    const io = fileDrainIO(hermes, command, fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    await io.save({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    expect(await io.publishMarker(at)).toBe(true);
    await io.stop();
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await writeFile(hermes.drainMarker.path, foreign); await actual.rename(from, to); await writeFile(hermes.drainMarker.path, newer);
    });
    await expect(io.removeMarker(at)).rejects.toMatchObject({ code: 'EEXIST' });
    const staging = join(root, 'hermes', (await readdir(join(root, 'hermes'))).find(name => name.startsWith('.wayroost-'))!);
    const recover = () => {
      const fresh = fileDrainIO(hermes, command);
      return recovery === 'cleanup' ? cleanupDrain(fresh) : sweepDrain(fresh);
    };
    await expect(recover()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(stopped).toBe(false);
    expect(await io.load()).toMatchObject({ stopped_gateway: true, started_gateway: true });
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(newer);
    expect(await readFile(join(staging, 'marker'), 'utf8')).toBe(foreign);
    expect(JSON.parse(await readFile(join(staging, 'recovery.json'), 'utf8'))).toEqual({ requested_at: at });
    await expect(recover()).rejects.toMatchObject({ code: 'EEXIST' });
    await actual.unlink(hermes.drainMarker.path);
    await recover();
    expect(command.mock.calls.filter(([argv]) => argv.includes('start')).map(([argv]) => argv)).toEqual([
      ['systemctl', '--user', '--no-block', 'start', hermes.gatewayUnit],
    ]);
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect(await io.load()).toBeNull(); expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it.each(['cleanup', 'sweep'])('recovers a foreign capture after interruption through %s with a fresh executor', async recovery => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const command = vi.fn(async () => ({ code: 3, stdout: 'inactive\n' }));
    const io = fileDrainIO(hermes, command, fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); const foreign = JSON.stringify({ principal: 'other', requested_at: at });
    await io.save({ phase: 'draining', marker_requested_at: at, stopped_gateway: false, started_gateway: false });
    expect(await io.publishMarker(at)).toBe(true);
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      const journal = join(String(to), '../recovery.json');
      expect(JSON.parse(await readFile(journal, 'utf8'))).toEqual({ requested_at: at });
      expect((await lstat(journal)).mode & 0o777).toBe(0o600);
      await writeFile(hermes.drainMarker.path, foreign); await actual.rename(from, to);
      throw Object.assign(new Error(), { code: 'EIO' });
    });
    await expect(io.removeMarker(at)).rejects.toThrow();
    await expect(lstat(hermes.drainMarker.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const fresh = fileDrainIO(hermes, command);
    await (recovery === 'cleanup' ? cleanupDrain(fresh) : sweepDrain(fresh));
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect(await fresh.load()).toBeNull(); expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it('removes an interrupted owner capture during sweep without executor state', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); expect(await io.publishMarker(at)).toBe(true);
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await actual.rename(from, to); throw Object.assign(new Error(), { code: 'EIO' });
    });
    await expect(io.removeMarker(at)).rejects.toThrow();
    await sweepDrain(fileDrainIO(hermes, async () => ({ code: 3, stdout: 'inactive\n' })));
    expect(await readdir(join(root, 'hermes'))).toEqual([]); expect(await io.load()).toBeNull();
  });
  it('sweeps an interrupted capture intent without moving the public marker first', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); expect(await io.publishMarker(at)).toBe(true);
    vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error(), { code: 'EIO' }));
    await expect(io.removeMarker(at)).rejects.toMatchObject({ code: 'EIO' });
    expect(await io.marker()).toMatchObject({ principal: 'wayroost', requested_at: at });
    await sweepDrain(fileDrainIO(hermes, async () => ({ code: 3, stdout: 'inactive\n' })));
    expect(await readdir(join(root, 'hermes'))).toEqual([]);
  });
  it('recovers a foreign link restored just before interruption without treating it as a collision', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const io = fileDrainIO(hermes, vi.fn(), fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); const foreign = '{'; expect(await io.publishMarker(at)).toBe(true);
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await writeFile(hermes.drainMarker.path, foreign); await actual.rename(from, to);
    });
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      await actual.link(from, to);
      if (String(to) === hermes.drainMarker.path) throw Object.assign(new Error(), { code: 'EIO' });
    });
    await expect(io.removeMarker(at)).rejects.toMatchObject({ code: 'EIO' });
    vi.mocked(fs.link).mockImplementation(actual.link);
    await cleanupDrain(fileDrainIO(hermes, vi.fn()));
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect((await lstat(hermes.drainMarker.path)).nlink).toBe(1);
    expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it.each(['removal', 'recovery'])('preserves an owned marker on disk and defers start after repeated %s errors', async failure => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const command = vi.fn(async () => ({ code: 0, stdout: '' })); const error = Object.assign(new Error(), { code: 'EIO' });
    const io = fileDrainIO(hermes, command, fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); const state: DrainState = { phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false };
    await io.save(state); expect(await io.publishMarker(at)).toBe(true);
    let time = base; io.now = () => time; io.sleep = async ms => { time += ms; };
    if (failure === 'removal') vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === hermes.drainMarker.path) throw error;
      await actual.rename(from, to);
    });
    else vi.spyOn(io, 'recoverMarkers').mockRejectedValue(error);
    await expect(cleanupDrain(io)).rejects.toThrow(); expect(command).not.toHaveBeenCalled();
    expect(await io.marker()).toMatchObject({ principal: 'wayroost', requested_at: at }); expect(await io.load()).toEqual(state);
    expect(time - base).toBeLessThanOrEqual(150_000);
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    const fresh = fileDrainIO(hermes, command); await cleanupDrain(fresh);
    expect(await fresh.marker()).toBeNull(); expect(await fresh.load()).toBeNull(); expect(await readdir(join(root, 'hermes'))).toEqual([]);
    expect(command.mock.calls).toEqual([[['systemctl', '--user', '--no-block', 'start', hermes.gatewayUnit], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000]]);
  });
  it('retains failed foreign restoration for retry and starts a stopped gateway before recovery succeeds', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes'), { mode: 0o700 });
    const command = vi.fn(async () => {
      await expect(lstat(hermes.drainMarker.path)).rejects.toMatchObject({ code: 'ENOENT' });
      return { code: 0, stdout: '' };
    });
    const io = fileDrainIO(hermes, command, fetch, async () => '11111111-2222-3333-4444-555555555555:12345');
    const at = new Date(base).toISOString(); const foreign = JSON.stringify({ principal: 'other', requested_at: at });
    await io.save({ phase: 'stopping', marker_requested_at: at, stopped_gateway: true, started_gateway: false });
    expect(await io.publishMarker(at)).toBe(true);
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await writeFile(hermes.drainMarker.path, foreign); await actual.rename(from, to);
    });
    vi.mocked(fs.link).mockImplementation(async (from, to) => {
      if (String(to) === hermes.drainMarker.path) throw Object.assign(new Error(), { code: 'EIO' });
      await actual.link(from, to);
    });
    await expect(io.removeMarker(at)).rejects.toMatchObject({ code: 'EIO' });
    const fresh = fileDrainIO(hermes, command);
    await expect(cleanupDrain(fresh)).rejects.toMatchObject({ code: 'EIO' });
    expect(await fresh.load()).toMatchObject({ stopped_gateway: true, started_gateway: true });
    expect(command.mock.calls).toContainEqual([['systemctl', '--user', '--no-block', 'start', hermes.gatewayUnit], { XDG_RUNTIME_DIR: '/run/user/' + hermes.runAs.uid }, 150_000]);
    vi.mocked(fs.link).mockImplementation(actual.link);
    await cleanupDrain(fileDrainIO(hermes, command));
    expect(command).toHaveBeenCalledTimes(1);
    expect(await readFile(hermes.drainMarker.path, 'utf8')).toBe(foreign);
    expect(await fresh.load()).toBeNull(); expect(await readdir(join(root, 'hermes'))).toEqual(['.drain_request.json']);
  });
  it('reads cron as clear without an optional profiles directory', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes/cron'), { recursive: true });
    await writeFile(hermes.cronJobs, '{"jobs":[]}'); expect(await fileDrainIO(hermes, vi.fn()).cron()).toBe(true);
    await symlink(join(root, 'hermes/cron'), hermes.profilesDir); expect(await fileDrainIO(hermes, vi.fn()).cron()).toBe(false);
  });
  it('does not treat a missing profile directory behind an unsafe ancestor as optional', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes/cron'), { recursive: true });
    await writeFile(hermes.cronJobs, '{"jobs":[]}'); await symlink(join(root, 'hermes'), join(root, 'alias'));
    hermes.profilesDir = join(root, 'alias/profiles'); expect(await fileDrainIO(hermes, vi.fn()).cron()).toBe(false);
  });
  it('keeps unreadable profile storage busy', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(join(root, 'hermes/cron'), { recursive: true });
    await writeFile(hermes.cronJobs, '{"jobs":[]}');
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith('/profiles')) throw Object.assign(new Error(), { code: 'EACCES' });
      return actual.open(...args);
    });
    try { expect(await fileDrainIO(hermes, vi.fn()).cron()).toBe(false); }
    finally { vi.mocked(fs.open).mockImplementation(actual.open); }
  });
  it('discovers profile cron claims and treats unreadable stores as busy', async () => {
    const root = await temporary(); const hermes = target(root); await mkdir(hermes.profilesDir, { recursive: true }); await mkdir(join(hermes.profilesDir, 'example/cron'), { recursive: true });
    await mkdir(join(root, 'hermes/cron'), { recursive: true }); await writeFile(hermes.cronJobs, '{"jobs":[]}');
    await writeFile(join(hermes.profilesDir, 'example/cron/jobs.json'), JSON.stringify({ jobs: [{ enabled: true, schedule: { kind: 'cron' }, fire_claim: { at: new Date().toISOString() } }] }));
    expect(await fileDrainIO(hermes, vi.fn()).cron()).toBe(false);
  });
});
