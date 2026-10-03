import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BackgroundGate } from '../src/background.js';
import { EventHub } from '../src/hub.js';
import { TaskRelay } from '../src/tasks/relay.js';
import { WorkerUpdatesSetting } from '../src/tasks/setting.js';
import { TaskStore, type TaskRecord } from '../src/tasks/store.js';
import { apiHeaders, makeApp, makeKeys, makeToken, ORIGIN, type Keys } from './helpers.js';

let keys: Keys;
let token: string;
beforeAll(async () => { keys = await makeKeys(); token = await makeToken(keys); });

function ledger() {
  const state = mkdtempSync(join(tmpdir(), 'sb-task-status-'));
  const store = new TaskStore(state, () => 1000);
  const base: TaskRecord = { id: '00000000-0000-4000-8000-000000000001', title: 'Demo unlinked worker',
    provider: 'pi', cwd: '/home/me/code/app', chat: 'demo-launching-chat', verified: false,
    linkReason: 'Not linked: no successful launch proof.', status: 'running',
    createdAt: 0, startedAt: 0, dueAt: 500, dueMinutes: 1, round: 1, since: 0, changedAt: 100, lastSeen: 100,
    relays: [{ id: 'overdue#1', kind: 'overdue', attempts: 0, queuedAt: 100, held: 'Held: recipient readiness is unknown.' }],
    criteria: ['Private implementation detail'] };
  store.add(base);
  store.add({ ...base, id: '00000000-0000-4000-8000-000000000002', title: 'Demo failed delivery', role: 'reviewer',
    verified: true, linkReason: undefined, status: 'finished', changedAt: 200,
    relays: [{ id: 'finished#1', kind: 'update', attempts: 5, failures: 5, queuedAt: 100, skipped: 'not delivered' }] });
  store.save();
  const reloaded = new TaskStore(state, () => 1000);
  const relay = new TaskRelay({ background: new BackgroundGate('primary'), store: reloaded, setting: new WorkerUpdatesSetting(state), hub: new EventHub(),
    workers: { agentsLoaded: false, workerSnapshot: () => undefined, workerSnapshots: () => [],
      lookUp: async () => null, lastMessage: async () => undefined },
    chats: { connected: () => false, rows: async () => [], find: async () => undefined, origin: async () => undefined },
    bridge: { deliverSystem: () => 'queued', withdrawSystem: () => false, watch() {}, status: () => ({ paused: false }) },
    log: { info() {}, warn() {}, error() {} }, now: () => 1000, tickMs: 0 });
  return { relay, reloaded };
}

describe('authenticated task status', () => {
  it.each([true, false])('reports task availability successfully before reading the ledger (available %s)', async available => {
    const { app } = await makeApp(keys, { ...(available ? { tasks: { status: () => ({ tasks: [] }) } } : {}) });
    try {
      const response = await app.inject({ url: '/api/capabilities', headers: apiHeaders(token) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tasks: available });
      expect((await app.inject({ url: '/api/capabilities', headers: { host: new URL(ORIGIN).host, 'x-wayroost-request': '1' } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('returns persisted linkage, held and exhausted delivery reasons with role, chat, status and overdue', async () => {
    const { relay, reloaded } = ledger();
    const { app } = await makeApp(keys, { tasks: relay });
    try {
      const response = await app.inject({ url: '/api/tasks', headers: apiHeaders(token) });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const tasks = response.json().tasks;
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({ role: 'reviewer', status: 'finished', chat: 'demo-launching-chat', overdue: false,
        relays: [{ skipped: 'not delivered', failures: 5 }] });
      expect(tasks[1]).toMatchObject({ role: 'worker', verified: false, linkReason: 'Not linked: no successful launch proof.',
        status: 'running', overdue: true, relays: [{ held: 'Held: recipient readiness is unknown.' }] });
      expect(response.body).not.toContain('cwd');
      expect(response.body).not.toContain('criteria');
      reloaded.get(tasks[1].id)!.relays[0]!.deliveredAt = 900;
      const refreshed = await app.inject({ url: '/api/tasks', headers: apiHeaders(token) });
      expect(refreshed.json().tasks[1].relays[0].deliveredAt).toBe(900);
    } finally { await app.close(); }
  });

  it('rejects unauthenticated status requests and requests without the browser marker', async () => {
    const { relay } = ledger();
    const { app } = await makeApp(keys, { tasks: relay });
    try {
      expect((await app.inject({ url: '/api/tasks', headers: { host: new URL(ORIGIN).host, 'x-wayroost-request': '1' } })).statusCode).toBe(401);
      const { 'x-wayroost-request': marker, ...headers } = apiHeaders(token);
      expect(marker).toBe('1');
      expect((await app.inject({ url: '/api/tasks', headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('reports unavailable task support instead of an empty ledger', async () => {
    const { app } = await makeApp(keys);
    try {
      const response = await app.inject({ url: '/api/tasks', headers: apiHeaders(token) });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Tasks need the bridge, Hermes and Paseo.' });
    } finally { await app.close(); }
  });
});
