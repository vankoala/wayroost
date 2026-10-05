import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { authenticate, hashKey, loadKeys, permits } from '../src/keys.js';
import { CATALOGUE_VERSION } from '../../shared/settings-ops.js';
import type { SupervisorStatus } from '../../shared/supervisor.js';
import {
  CONFIG_ROUTE_FOR, CONFIG_VERBS, CONFIG_WRITE_VERBS, DRAIN_IDLE_MIN_GAP_MS, DRAIN_RESTART_OUTCOMES, HERMES_DRAIN_PROTOCOL, KEY_ROLE_ACCESS, LAUNCHER_KEY_NAME, configApplyRequestSchema,
  configAuditRowSchema, configReadRequestSchema, configReadResultSchema, configUndoRequestSchema, configVerbsStatusSchema,
  configWriteResultSchema, credentialTestRequestSchema, credentialTestResultSchema, credentialWriteRequestSchema, cronBlocksDrain, currentConfigVerbs,
  drainExecutorStateSchema, drainIdlePair, drainIdlePairSchema, drainMarkerSchema, drainRestartOutcomeSchema, drainRestartRequestSchema, drainRestartRunSchema, drainWaitDecision,
  keyMay, keyRole, usageSummaryRequestSchema, usageSummaryResultSchema,
} from '../../shared/supervisor-config.js';

const sha = (digit: string) => digit.repeat(64);
const token = { operation: 'hermes.approval-mode', target: 'hermes-config', backupId: `${sha('a')}/demo.bak`, backupSha256: sha('b'), writtenSha256: sha('c') };
let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); folder = undefined; });

describe("the launcher's key", () => {
  it('is a server-scope entry the current strict key loader reads', async () => {
    folder = mkdtempSync(join(tmpdir(), 'wayroost-keys-'));
    const path = join(folder, 'supervisor-keys.json');
    const keys = { server: 'demo-server-key-0123456789', rescue: 'demo-rescue-key-0123456789', launcher: 'demo-launcher-key-0123456789' };
    writeFileSync(path, JSON.stringify([
      { name: 'server', scope: 'server', sha256: hashKey(keys.server) },
      { name: 'desktop-rescue', scope: 'rescue', sha256: hashKey(keys.rescue) },
      { name: LAUNCHER_KEY_NAME, scope: 'server', sha256: hashKey(keys.launcher) },
    ], null, 2) + '\n', { mode: 0o600 });
    const loaded = await loadKeys(path);
    expect(loaded.map(key => key.name)).toEqual(['server', 'desktop-rescue', 'launcher']);
    const launcher = authenticate(keys.launcher, loaded);
    expect(launcher).toMatchObject({ name: LAUNCHER_KEY_NAME, scope: 'server' });
    expect(keyRole(launcher!)).toBe('launcher');
    expect(keyRole(authenticate(keys.server, loaded)!)).toBe('server');
    expect(keyRole(authenticate(keys.rescue, loaded)!)).toBe('rescue');
    // The previous release treats it as a server key; status-only mode keeps its actions refused.
    expect(permits(launcher!, { verb: 'restart', target: 'paseo' })).toBe(true);
  });

  it('would stop the current loader if it carried a field of its own', async () => {
    folder = mkdtempSync(join(tmpdir(), 'wayroost-keys-'));
    const path = join(folder, 'supervisor-keys.json');
    writeFileSync(path, JSON.stringify([{ name: LAUNCHER_KEY_NAME, scope: 'launcher', sha256: sha('d') }]), { mode: 0o600 });
    await expect(loadKeys(path)).rejects.toThrow();
    writeFileSync(path, JSON.stringify([{ name: LAUNCHER_KEY_NAME, scope: 'server', sha256: sha('d'), verbs: ['config.apply'] }]), { mode: 0o600 });
    await expect(loadKeys(path)).rejects.toThrow();
  });

  it('reads status and applies its own operations, and nothing else', () => {
    expect(KEY_ROLE_ACCESS.launcher).toEqual(['status', 'config.read', 'config.apply']);
    for (const capability of ['events', 'actions', 'busy', 'config.undo', 'credential.write', 'credential.test', 'service.drain-restart', 'usage.summary'] as const) {
      expect(keyMay('launcher', capability), capability).toBe(false);
    }
    for (const verb of CONFIG_VERBS) {
      expect(keyMay('server', verb)).toBe(true);
      expect(keyMay('rescue', verb)).toBe(false);
    }
  });
});

describe('idle restart safety', () => {
  const requestId = '01234567-89ab-4cde-8fab-0123456789ab';
  const markerAt = '2026-01-02T03:04:05.000Z';
  const now = Date.parse(markerAt);
  const iso = (seconds: number) => new Date(now + seconds * 1000).toISOString();

  it('pins drain, probe, cron, phone and recovery deadlines', () => {
    expect(HERMES_DRAIN_PROTOCOL.timing).toEqual({
      drainPollSeconds: 1, waitPollSeconds: 15, drainLimitSeconds: 180, retrySeconds: 600, overallLimitSeconds: 7200,
      staleCountProbeSeconds: 600, oneShotWindowSeconds: 300, claimTtlSeconds: 300, claimFutureSkewSeconds: 60,
      phoneTimeoutSeconds: 12, engageDeadlineSeconds: 5, verifyDeadlineSeconds: 150, unitRuntimeMaxSeconds: 8100, unitStopTimeoutSeconds: 150,
    });
    expect(drainRestartRequestSchema.parse({ requestId, component: 'hermes', when: 'idle' }).protocol).toBe(1);
    expect(drainRestartRequestSchema.safeParse({ requestId, component: 'hermes', when: 'idle', protocol: 2 }).success).toBe(false);
    expect(drainRestartRequestSchema.safeParse({ requestId, component: 'hermes', when: 'idle', skipPhone: true }).success).toBe(false);
  });

  it('probes a stale nonzero count only when every other check is clear', () => {
    const observation = { activeAgents: '1', unchangedForSeconds: 600, phoneClear: true, cronClear: true,
      backgroundClear: true, markerAbsent: true, gatewayState: 'running' };
    expect(drainWaitDecision(observation)).toBe('probe');
    expect(drainWaitDecision({ ...observation, unchangedForSeconds: 599 })).toBe('wait');
    expect(drainWaitDecision({ ...observation, activeAgents: '0' })).toBe('drain');
    for (const field of ['phoneClear', 'cronClear', 'backgroundClear', 'markerAbsent']) {
      expect(drainWaitDecision({ ...observation, [field]: false }), field).toBe('wait');
      expect(drainWaitDecision({ ...observation, [field]: undefined }), field).toBe('wait');
    }
    for (const activeAgents of [undefined, null, true, -1, 0.5, 0]) {
      expect(drainWaitDecision({ ...observation, activeAgents })).toBe('wait');
    }
    expect(HERMES_DRAIN_PROTOCOL.drain.chatAtEntry).toBe('remove-own-marker-and-wait');
    expect(HERMES_DRAIN_PROTOCOL.drain.callStartsOrPhoneUnreadable).toBe('remove-own-marker-and-wait');
  });

  it('validates the original JSON count token before deciding to drain or probe', () => {
    const observation = { unchangedForSeconds: 600, phoneClear: true, cronClear: true,
      backgroundClear: true, markerAbsent: true, gatewayState: 'running' };
    for (const activeAgents of ['0.0', '0e0', '0E+0', '-0', '1.0', '1e0', '01', '-1', '"0"', 'false', 'null', '', '9007199254740992']) {
      expect(drainWaitDecision({ ...observation, activeAgents }), activeAgents).toBe('wait');
    }
    for (const json of ['0.0', '0e0']) {
      expect(drainWaitDecision({ ...observation, activeAgents: JSON.parse(json) }), json).toBe('wait');
    }
    expect(drainWaitDecision({ ...observation, activeAgents: ' \n0\t' })).toBe('drain');
    expect(drainWaitDecision({ ...observation, activeAgents: '2' })).toBe('probe');
  });

  it('guards runnable one-shots including overdue jobs and recent claims for every job', () => {
    const job = { kind: 'once', runnable: true, nextRunAt: iso(300), claims: [] };
    expect(cronBlocksDrain(job, now)).toBe(true);
    expect(cronBlocksDrain({ ...job, nextRunAt: iso(-100) }, now)).toBe(true);
    expect(cronBlocksDrain({ ...job, nextRunAt: iso(301) }, now)).toBe(false);
    expect(cronBlocksDrain({ ...job, runnable: false }, now)).toBe(false);
    expect(cronBlocksDrain({ ...job, kind: 'recurring', nextRunAt: iso(60) }, now)).toBe(false);
    for (const kind of ['once', 'recurring']) {
      expect(cronBlocksDrain({ ...job, kind, runnable: false, claims: [iso(-299)] }, now)).toBe(true);
      expect(cronBlocksDrain({ ...job, kind, runnable: false, claims: [iso(60)] }, now)).toBe(true);
      expect(cronBlocksDrain({ ...job, kind, runnable: false, claims: [iso(-300)] }, now)).toBe(false);
    }
    expect(cronBlocksDrain({ ...job, nextRunAt: '2026-01-02T03:04:05' }, now)).toBe(true);
    expect(cronBlocksDrain({ ...job, nextRunAt: undefined }, now)).toBe(true);
    expect(HERMES_DRAIN_PROTOCOL.wait.cronStores).toBe('main-and-all-profiles');
    expect(HERMES_DRAIN_PROTOCOL.wait.claims).toBe('fire-and-run-for-all-jobs');
    expect(HERMES_DRAIN_PROTOCOL.wait.recurring).toBe('catch-up-after-release');
  });

  it('requires two fresh idle writes and releases a drain for a starting call', () => {
    const first = { state: 'draining', updatedAt: iso(1), readAt: now + 1000, activeAgents: '0',
      backgroundClear: true, phoneClear: true, markerOwned: true };
    const second = { ...first, updatedAt: iso(2), readAt: now + 2000 };
    expect(drainIdlePair(first, second, markerAt)).toBe(true);
    expect(drainIdlePair(first, { ...second, updatedAt: first.updatedAt }, markerAt)).toBe(false);
    expect(drainIdlePair(first, { ...second, readAt: now + 1999 }, markerAt)).toBe(false);
    expect(drainIdlePair({ ...first, updatedAt: markerAt }, second, markerAt)).toBe(false);
    for (const field of ['backgroundClear', 'phoneClear', 'markerOwned']) expect(drainIdlePair(first, { ...second, [field]: false }, markerAt), field).toBe(false);
    for (const activeAgents of [1, '1', false, null, undefined, 0]) expect(drainIdlePair(first, { ...second, activeAgents }, markerAt)).toBe(false);
    const waiting = { id: requestId, component: 'hermes', when: 'idle', state: 'waiting', startedAt: now,
      attempts: 1, probeAttempts: 1, busy: ['call'], lastRelease: 'call-started' };
    expect(drainRestartRunSchema.safeParse(waiting).success).toBe(true);
    expect(drainRestartRunSchema.safeParse({ ...waiting, probeAttempts: 2 }).success).toBe(false);
  });

  it('requires valid raw JSON integer counts in both fresh idle readings', () => {
    const first = { state: 'draining', updatedAt: iso(1), readAt: now + 1000, activeAgents: '0',
      backgroundClear: true, phoneClear: true, markerOwned: true };
    const second = { ...first, updatedAt: iso(2), readAt: now + 2000 };
    for (const activeAgents of ['0.0', '0e0', '0E+0', '-0', '01', '"0"', 'false', 'null', '', JSON.parse('0.0'), JSON.parse('0e0')]) {
      expect(drainIdlePair({ ...first, activeAgents }, second, markerAt), String(activeAgents)).toBe(false);
      expect(drainIdlePair(first, { ...second, activeAgents }, markerAt), String(activeAgents)).toBe(false);
    }
    for (const json of ['0.0', '0e0']) {
      expect(drainIdlePair({ ...first, activeAgents: JSON.parse(json) }, { ...second, activeAgents: JSON.parse(json) }, markerAt), json).toBe(false);
    }
    expect(drainIdlePair({ ...first, activeAgents: '\t0\n' }, second, markerAt)).toBe(true);
  });

  it('requires the idle writes themselves to be at least one second apart', () => {
    expect(DRAIN_IDLE_MIN_GAP_MS).toBe(1000);
    const first = { state: 'draining', updatedAt: iso(1), readAt: now + 1000, activeAgents: '0',
      backgroundClear: true, phoneClear: true, markerOwned: true };
    for (const milliseconds of [1, 999]) {
      expect(drainIdlePair(first, { ...first, updatedAt: new Date(now + 1000 + milliseconds).toISOString(), readAt: now + 3000 }, markerAt)).toBe(false);
    }
    expect(drainIdlePair(first, { ...first, updatedAt: iso(2), readAt: now + 3000 }, markerAt)).toBe(true);
    for (const gap of [DRAIN_IDLE_MIN_GAP_MS - 1, DRAIN_IDLE_MIN_GAP_MS, DRAIN_IDLE_MIN_GAP_MS + 1]) {
      const second = { ...first, updatedAt: new Date(now + 1000 + gap).toISOString(), readAt: first.readAt + gap };
      expect(drainIdlePairSchema.safeParse({ first, second, markerRequestedAt: markerAt }).success).toBe(gap >= DRAIN_IDLE_MIN_GAP_MS);
      expect(drainIdlePair(first, second, markerAt)).toBe(gap >= DRAIN_IDLE_MIN_GAP_MS);
    }
  });

  it('carries every fixed executor outcome and distinguishes success, waiting and failure', () => {
    expect(DRAIN_RESTART_OUTCOMES).toEqual(['restarted', 'restart_unverified', 'still_busy', 'foreign_drain', 'marker_lost', 'drain_not_engaged', 'not_running']);
    const run = { id: requestId, component: 'hermes', when: 'idle', startedAt: now, endedAt: now + 2000, attempts: 1,
      busy: ['background-job', 'delegated-task', 'phone-unavailable'] };
    for (const outcome of DRAIN_RESTART_OUTCOMES) {
      const state = outcome === 'restarted' || outcome === 'not_running' ? 'done' : outcome === 'still_busy' ? 'still-busy' : 'failed';
      expect(drainRestartOutcomeSchema.safeParse({ outcome }).success, outcome).toBe(true);
      expect(drainRestartRunSchema.safeParse({ ...run, state, outcome }).success, outcome).toBe(true);
      expect(drainRestartOutcomeSchema.safeParse({ outcome, message: 'raw details' }).success, outcome).toBe(false);
    }
    expect(drainRestartRunSchema.safeParse({ ...run, state: 'done', outcome: 'restart_unverified' }).success).toBe(false);
    expect(drainRestartRunSchema.safeParse({ ...run, state: 'done', outcome: 'restarted', endedAt: undefined }).success).toBe(false);
    expect(drainRestartRunSchema.safeParse({ ...run, state: 'done' }).success).toBe(false);
  });

  it('records marker ownership and durable cleanup before side effects', () => {
    const marker = { action: 'drain', requested_at: markerAt, principal: 'wayroost',
      epoch: '01234567-89ab-cdef-0123-456789abcdef:123', suppress_notification: true };
    expect(drainMarkerSchema.safeParse(marker).success).toBe(true);
    expect(drainMarkerSchema.safeParse({ ...marker, requested_at: '2026-01-02T03:04:05' }).success).toBe(false);
    expect(drainMarkerSchema.safeParse({ ...marker, principal: 'other' }).success).toBe(false);
    expect(drainExecutorStateSchema.safeParse({ phase: 'cleared', marker_requested_at: markerAt, stopped_gateway: true, started_gateway: false }).success).toBe(true);
    expect(drainExecutorStateSchema.safeParse({ phase: 'starting', marker_requested_at: markerAt, stopped_gateway: false, started_gateway: true }).success).toBe(false);
    expect(HERMES_DRAIN_PROTOCOL.state.beforeSideEffects).toBe(true);
    expect(HERMES_DRAIN_PROTOCOL.marker.publish).toBe('exclusive-temp-fsync-link-unlink-fsync-directory');
    expect(HERMES_DRAIN_PROTOCOL.restart.order).toEqual(['record-stop', 'stop', 'clear-own-marker', 'record-cleared', 'start', 'record-started', 'verify']);
    expect(HERMES_DRAIN_PROTOCOL.cleanup).toEqual({ everyExitIncludingKillAndTimeout: true,
      order: ['remove-own-marker', 'start-if-stopped-not-started', 'delete-state'], start: 'no-block',
      sweep: 'remove-wayroost-marker-only-with-no-active-executor' });
    expect(HERMES_DRAIN_PROTOCOL.unit.pid1Visible).toBe(true);
    expect(HERMES_DRAIN_PROTOCOL.unit.network).toBe('real-loopback-only');
  });
});

describe('configWrites stays out of supervisor.json', () => {
  it('because the current strict config loader would refuse the file', () => {
    expect(configSchema.safeParse({}).success).toBe(true);
    expect(configSchema.safeParse({ configWrites: true }).success).toBe(false);
  });
});

describe('the status field', () => {
  it('reports the verbs, the switch and the catalogue version', () => {
    const field = currentConfigVerbs(true);
    expect(configVerbsStatusSchema.parse(field)).toEqual({ version: 1, configWrites: true, verbs: [...CONFIG_VERBS], catalogue: CATALOGUE_VERSION });
    const status: SupervisorStatus = { overall: 'ok', sentence: 'Everything is running.', components: [], configVerbs: currentConfigVerbs(false), at: 1 };
    expect(status.configVerbs?.configWrites).toBe(false);
  });

  it('is read loosely, so a newer supervisor still parses', () => {
    expect(configVerbsStatusSchema.safeParse({ ...currentConfigVerbs(true), future: 1 }).success).toBe(true);
    const parsed = configVerbsStatusSchema.parse({ ...currentConfigVerbs(true), verbs: [...CONFIG_VERBS, 'project.scan'], future: 1 });
    expect(parsed.verbs).toContain('config.apply');
    expect(parsed.verbs).toContain('project.scan');
    expect(configVerbsStatusSchema.safeParse({ ...currentConfigVerbs(true), verbs: ['config.apply', 42] }).success).toBe(false);
  });

  it('has a route for every verb, and writes are the changing ones', () => {
    expect(Object.keys(CONFIG_ROUTE_FOR).sort()).toEqual([...CONFIG_VERBS].sort());
    expect(new Set(Object.values(CONFIG_ROUTE_FOR)).size).toBe(CONFIG_VERBS.length);
    expect([...CONFIG_WRITE_VERBS].sort()).toEqual(['config.apply', 'config.undo', 'credential.write', 'service.drain-restart']);
  });
});

describe('config verb requests', () => {
  const requestId = randomUUID();

  it('reads by view id, never by path', () => {
    expect(configReadRequestSchema.safeParse({ view: 'hermes.safety' }).success).toBe(true);
    expect(configReadRequestSchema.safeParse({ view: 'hermes.safety', path: '/home/me/.demo/config.yaml' }).success).toBe(false);
    expect(configReadRequestSchema.safeParse({ view: '/home/me/.demo/config.yaml' }).success).toBe(false);
  });

  it('answers a read with values by key path, or a code', () => {
    expect(configReadResultSchema.safeParse({ ok: true, view: 'hermes.safety', present: true, sha256: sha('a'),
      values: [{ path: ['approvals', 'mode'], exists: true, value: 'manual' }, { path: ['skills', 'write_approval'], exists: false }] }).success).toBe(true);
    expect(configReadResultSchema.safeParse({ ok: false, code: 'unsafe_target' }).success).toBe(true);
    expect(configReadResultSchema.safeParse({ ok: false, code: 'parse_failed', message: 'line 3: bad indent' }).success).toBe(false);
  });

  it('versions present reads by content hash and never by mtime', () => {
    const read = { ok: true, view: 'hermes.safety', present: true, sha256: sha('a'), values: [] };
    expect(configReadResultSchema.safeParse(read).success).toBe(true);
    expect(configReadResultSchema.safeParse({ ...read, mtimeNs: '1700000000000000000' }).success).toBe(false);
    expect(configReadResultSchema.safeParse({ ...read, sha256: undefined }).success).toBe(false);
    expect(configReadResultSchema.safeParse({ ok: true, view: 'hermes.safety', present: false, values: [] }).success).toBe(true);
    expect(configReadResultSchema.safeParse({ ...read, present: false }).success).toBe(false);
  });

  it('applies an operation with typed parameters, optional preconditions and origin', () => {
    const request = {
      requestId, operation: 'hermes.approval-mode', params: { mode: 'manual' }, preconditions: { keys: [{ key: 0, value: 'smart' }] },
      origin: { change: 'ch_0123456789abcdef01234567', device: { id: 'dv_0123456789abcdef01234567', kind: 'desktop' }, level: 'anywhere' },
    };
    expect(configApplyRequestSchema.safeParse(request).success).toBe(true);
    expect(configApplyRequestSchema.safeParse({ ...request, afterSeconds: 60 }).success).toBe(true);
    expect(configApplyRequestSchema.safeParse({ ...request, afterSeconds: 3600 }).success).toBe(false);
    expect(configApplyRequestSchema.safeParse({ ...request, target: '/home/me/.demo/config.yaml' }).success).toBe(false);
    expect(configApplyRequestSchema.safeParse({ ...request, requestId: 'not-a-uuid' }).success).toBe(false);
    expect(configApplyRequestSchema.safeParse({ ...request, operation: 'sh -c id' }).success).toBe(false);
  });

  it('undoes by token only', () => {
    expect(configUndoRequestSchema.safeParse({ requestId, token }).success).toBe(true);
    expect(configUndoRequestSchema.safeParse({ requestId, token: { ...token, backupId: '../../etc/shadow' } }).success).toBe(false);
  });

  it('reports a write as committed when the file changed, with its undo, and as a code otherwise', () => {
    expect(configWriteResultSchema.safeParse({ ok: true, operation: token.operation, target: token.target, keys: ['approvals.mode'],
      backupId: token.backupId, backupSha256: sha('b'), writtenSha256: sha('c'), undo: token }).success).toBe(true);
    expect(configWriteResultSchema.safeParse({ ok: false, code: 'verify_mismatch', committed: true, undo: token }).success).toBe(true);
    expect(configWriteResultSchema.safeParse({ ok: false, code: 'locked' }).success).toBe(true);
    expect(configWriteResultSchema.safeParse({ ok: true, scheduled: true, runAt: 1 }).success).toBe(false);
    expect(configWriteResultSchema.safeParse({ ok: false, code: 'parse_failed', detail: 'mapping values are not allowed here' }).success).toBe(false);
  });

  it('requires a target and known or unknown backup id for an unknown outcome', () => {
    for (const backupId of [token.backupId, null]) {
      expect(configWriteResultSchema.safeParse({ ok: false, code: 'outcome_unknown', target: token.target, backupId }).success).toBe(true);
    }
    for (const extra of [{}, { target: token.target }, { backupId: token.backupId }, { target: token.target, backupId: '../backup' }]) {
      expect(configWriteResultSchema.safeParse({ ok: false, code: 'outcome_unknown', ...extra }).success).toBe(false);
    }
    expect(configWriteResultSchema.safeParse({ ok: false, code: 'outcome_unknown', target: token.target, backupId: null, message: 'private text' }).success).toBe(false);
    expect(configWriteResultSchema.safeParse({ ok: false, code: 'outcome_unknown', committed: true, undo: token }).success).toBe(false);
  });

  it('takes a provider key once, as printable text, and removes by name', () => {
    expect(credentialWriteRequestSchema.safeParse({ requestId, action: 'set', provider: 'demo-cloud', secret: 'demo-key-0123' }).success).toBe(true);
    expect(credentialWriteRequestSchema.safeParse({ requestId, action: 'remove', provider: 'demo-cloud' }).success).toBe(true);
    expect(credentialWriteRequestSchema.safeParse({ requestId, action: 'remove', provider: 'demo-cloud', secret: 'x' }).success).toBe(false);
    for (const provider of ['../demo', 'Demo', 'demo/cloud', '']) {
      expect(credentialWriteRequestSchema.safeParse({ requestId, action: 'set', provider, secret: 'demo-key' }).success, provider).toBe(false);
    }
    expect(credentialWriteRequestSchema.safeParse({ requestId, action: 'set', provider: 'demo-cloud', secret: 'two words' }).success).toBe(false);
  });

  it('tests a stored key by provider and backend without sending the key to the server', () => {
    const request = { requestId, provider: 'demo-cloud', backend: 'demo-cloud-backend' };
    expect(credentialTestRequestSchema.safeParse(request).success).toBe(true);
    expect(credentialTestRequestSchema.safeParse({ ...request, secret: 'demo-key' }).success).toBe(false);
    expect(credentialTestRequestSchema.safeParse({ ...request, provider: '../demo' }).success).toBe(false);
    expect(credentialTestResultSchema.safeParse({ ok: true, provider: request.provider, backend: request.backend }).success).toBe(true);
    expect(credentialTestResultSchema.safeParse({ ok: false, code: 'credential_rejected' }).success).toBe(true);
    expect(credentialTestResultSchema.safeParse({ ok: false, code: 'not_configured' }).success).toBe(true);
    expect(credentialTestResultSchema.safeParse({ ok: false, code: 'credential_rejected', message: 'upstream text' }).success).toBe(false);
  });

  it('restarts the dashboard only now, and reports what held a run', () => {
    expect(drainRestartRequestSchema.safeParse({ requestId, component: 'hermes', when: 'idle' }).success).toBe(true);
    expect(drainRestartRequestSchema.safeParse({ requestId, component: 'dashboard', when: 'idle' }).success).toBe(false);
    expect(drainRestartRequestSchema.safeParse({ requestId, component: 'paseo', when: 'now' }).success).toBe(false);
    expect(drainRestartRunSchema.safeParse({ id: randomUUID(), component: 'hermes', when: 'idle', state: 'still-busy', startedAt: 1, endedAt: 2,
      attempts: 12, busy: ['call', 'cron-due'], code: 'still_busy', outcome: 'still_busy' }).success).toBe(true);
    expect(drainRestartRunSchema.safeParse({ id: randomUUID(), component: 'hermes', when: 'idle', state: 'waiting', startedAt: 1,
      attempts: 0, busy: ['a chat about the weather'] }).success).toBe(false);
  });

  it('summarises usage by role and backend, counts only', () => {
    expect(usageSummaryRequestSchema.safeParse({ windows: [{ id: 'today', since: 1 }, { id: 'week', since: 0 }] }).success).toBe(true);
    expect(usageSummaryRequestSchema.safeParse({ windows: [] }).success).toBe(false);
    const row = { role: 'main', backend: 'demo-main', backendModel: 'demo-main-model', requests: 3, errors: 0, inputTokens: 100,
      cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, estimatedCostUsd: 0 };
    expect(usageSummaryResultSchema.safeParse({ ok: true, generatedAt: 1, windows: [{ id: 'today', since: 1, rows: [row] }] }).success).toBe(true);
    expect(usageSummaryResultSchema.safeParse({ ok: true, generatedAt: 1, windows: [{ id: 'today', since: 1, rows: [{ ...row, prompt: 'hello' }] }] }).success).toBe(false);
  });
});

describe("the supervisor's config audit", () => {
  const row = { id: randomUUID(), time: '2026-01-02T03:04:05.000Z', caller: 'server', verb: 'config.apply', operation: 'hermes.approval-mode',
    target: 'hermes-config', keys: ['approvals.mode'], backupId: token.backupId, backupSha256: sha('b'), writtenSha256: sha('c'),
    change: 'ch_0123456789abcdef01234567', result: 'ok' };

  it('records key names, backup ids and hashes', () => {
    expect(configAuditRowSchema.safeParse(row).success).toBe(true);
    expect(configAuditRowSchema.safeParse({ ...row, result: 'locked' }).success).toBe(true);
  });

  it.each(['value', 'params', 'secret', 'before', 'after'])('has no field %s that could hold a value', field => {
    expect(configAuditRowSchema.safeParse({ ...row, [field]: 'manual' }).success).toBe(false);
  });
});
