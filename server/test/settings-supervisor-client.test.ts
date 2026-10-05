import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SupervisorClient, SupervisorConfigUncertain } from '../src/supervisor-client.js';
import { CONFIG_ROUTES, currentConfigVerbs } from '../../shared/supervisor-config.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'settings-client-'));
  roots.push(root);
  const keyFile = join(root, 'fake-key');
  writeFileSync(keyFile, '0'.repeat(64), { mode: 0o600 });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new SupervisorClient(join(root, 'unused.sock'), keyFile, log);
  const call = vi.spyOn(client as unknown as { call(method: string, path: string, body: unknown, timeout: number): Promise<{ status: number; body: Buffer }> }, 'call');
  const reply = (status: number, value: unknown) => call.mockResolvedValueOnce({ status, body: Buffer.from(JSON.stringify(value)) });
  return { client, call, reply, log };
}

it('uses the typed config routes and passes only their validated request bodies', async () => {
  const f = fixture();
  const requestId = '00000000-0000-4000-8000-000000000001';
  const token = { operation: 'hermes.reasoning-effort', target: 'hermes-config' as const, backupId: 'demo-backup', backupSha256: 'a'.repeat(64), writtenSha256: 'b'.repeat(64) };
  f.reply(200, { ok: true, view: 'hermes.agents', present: false, values: [] });
  expect(await f.client.configRead({ view: 'hermes.agents' })).toMatchObject({ ok: true });
  f.reply(200, { ok: false, code: 'not_configured' });
  expect(await f.client.configApply({ requestId, operation: token.operation, params: { effort: 'high' } })).toEqual({ ok: false, code: 'not_configured' });
  f.reply(200, { ok: false, code: 'backup_mismatch' });
  expect(await f.client.configUndo({ requestId, token })).toEqual({ ok: false, code: 'backup_mismatch' });
  f.reply(200, { ok: true, provider: 'demo', timing: 'restart-when-idle:gateway' });
  await f.client.credentialWrite({ requestId, action: 'set', provider: 'demo', secret: 'obviously-fake-credential' });
  f.reply(200, { ok: false, code: 'credential_rejected' });
  expect(await f.client.credentialTest({ requestId, provider: 'demo', backend: 'demo' })).toEqual({ ok: false, code: 'credential_rejected' });
  f.reply(200, { ok: false, code: 'busy' });
  await f.client.drainRestart({ requestId, protocol: 1, component: 'hermes', when: 'idle' });
  f.reply(200, { ok: false, code: 'unavailable' });
  await f.client.usageSummary({ windows: [{ id: 'today', since: 0 }] });
  expect(f.call.mock.calls.map(call => call[1])).toEqual([CONFIG_ROUTES.read, CONFIG_ROUTES.apply, CONFIG_ROUTES.undo,
    CONFIG_ROUTES.credential, CONFIG_ROUTES.credentialTest, CONFIG_ROUTES.drainRestart, CONFIG_ROUTES.usage]);
  expect(f.call.mock.calls.every(call => call[0] === 'POST')).toBe(true);
  expect(f.log.error).not.toHaveBeenCalled();
});

it.each([
  { status: 401, body: { message: 'obviously-fake-private-text' }, code: 'not_permitted' },
  { status: 403, body: { message: 'obviously-fake-private-text' }, code: 'not_permitted' },
  { status: 404, body: { message: 'obviously-fake-private-text' }, code: 'config_writes_off' },
  { status: 500, body: { ok: true, view: 'hermes.agents', present: false, values: [] }, code: 'failed' },
  { status: 200, body: { ok: false, code: 'bad', message: 'obviously-fake-private-text' }, code: 'failed' },
])('reduces an upstream $status reply to a fixed code', async example => {
  const f = fixture();
  f.reply(example.status, example.body);
  expect(await f.client.configRead({ view: 'hermes.agents' })).toEqual({ ok: false, code: example.code });
  expect(f.log.error).not.toHaveBeenCalled();
  expect(f.log.warn).not.toHaveBeenCalled();
});

it('reduces transport errors and non-JSON replies without logging their text', async () => {
  const f = fixture();
  f.call.mockRejectedValueOnce(new Error('obviously-fake-private-text'));
  expect(await f.client.configRead({ view: 'hermes.agents' })).toEqual({ ok: false, code: 'unavailable' });
  f.call.mockResolvedValueOnce({ status: 200, body: Buffer.from('obviously-fake-private-text') });
  expect(await f.client.configRead({ view: 'hermes.agents' })).toEqual({ ok: false, code: 'failed' });
  expect(f.log.error).not.toHaveBeenCalled();
});

it('preserves the supervisor config capabilities in status', async () => {
  const f = fixture();
  f.reply(200, { overall: 'ok', sentence: 'Ready', components: [], at: 0, configVerbs: currentConfigVerbs(false) });
  expect((await f.client.status())?.configVerbs).toEqual(currentConfigVerbs(false));
});

it.each(['apply', 'undo', 'credential', 'restart'] as const)('distinguishes an uncertain %s transport outcome from a supervisor refusal', async action => {
  const f = fixture();
  const requestId = '00000000-0000-4000-8000-000000000001';
  const token = { operation: 'hermes.reasoning-effort', target: 'hermes-config' as const,
    backupId: 'demo-backup', backupSha256: 'a'.repeat(64), writtenSha256: 'b'.repeat(64) };
  const call = () => action === 'apply' ? f.client.configApply({ requestId, operation: token.operation, params: { effort: 'high' } })
    : action === 'undo' ? f.client.configUndo({ requestId, token })
      : action === 'credential' ? f.client.credentialWrite({ requestId, action: 'remove', provider: 'demo' })
        : f.client.drainRestart({ requestId, protocol: 1, component: 'hermes', when: 'idle' });
  f.call.mockRejectedValueOnce(new Error('demo-private-transport-text'));
  await expect(call()).rejects.toBeInstanceOf(SupervisorConfigUncertain);
  f.reply(200, { ok: false, code: 'unavailable' });
  expect(await call()).toEqual({ ok: false, code: 'unavailable' });
  f.call.mockResolvedValueOnce({ status: 200, body: Buffer.from('demo-private-transport-text') });
  await expect(call()).rejects.toMatchObject({ code: 'failed', message: 'failed' });
  expect(f.log.error).not.toHaveBeenCalled();
  expect(f.log.warn).not.toHaveBeenCalled();
});

it('looks up one supervisor request without sending a write or reading target values', async () => {
  const f = fixture();
  const requestId = '00000000-0000-4000-8000-000000000001';
  for (const state of ['missing', 'pending', 'interrupted'] as const) {
    f.reply(200, { ok: true, requestId, state });
    expect(await f.client.configRequestStatus({ requestId })).toEqual({ ok: true, requestId, state });
  }
  f.reply(200, { ok: true, requestId, state: 'terminal', outcome: 'applied', row: {
    id: requestId, time: new Date(0).toISOString(), caller: 'server', verb: 'config.apply', keys: [], result: 'ok',
  } });
  expect(await f.client.configRequestStatus({ requestId })).toMatchObject({ state: 'terminal', outcome: 'applied' });
  f.call.mockRejectedValueOnce(new Error('unavailable'));
  expect(await f.client.configRequestStatus({ requestId })).toEqual({ ok: false, code: 'unavailable' });
  f.reply(200, { ok: true, requestId, state: 'terminal', outcome: 'applied', row: { id: 'bad' } });
  expect(await f.client.configRequestStatus({ requestId })).toEqual({ ok: false, code: 'failed' });
  expect(f.call.mock.calls.every(([method, path, body]) => method === 'POST' && path === CONFIG_ROUTES.requestStatus
    && JSON.stringify(body) === JSON.stringify({ requestId }))).toBe(true);
});
