import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedExec, trustAny } from './fixtures.js';
import { Actions } from '../src/actions.js';
import { configSchema, type Adopt } from '../src/config.js';
import { BUILTIN_COMPONENTS, buildRegistry, isReady, loadRegistry } from '../src/registry.js';
import { authenticate, hashKey, loadKeys } from '../src/keys.js';
import { probe } from '../src/probes.js';
import { createSupervisor } from '../src/server.js';
import type { Exec } from '../src/probes.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
// Obviously fake paths: the fake runner never executes them.
const ADOPT = { launchScript: '/demo/bin/launch.sh', coderScript: '/demo/bin/launch-vllm.sh', holdDir: '/demo/state' };
async function fixture(exec: Exec = { async run(_argv, line) { line?.('demo output'); return 0; } }, busy?: () => Promise<boolean>, limit = 200, listen = true, adopt: Adopt = ADOPT, statusOnly = false) {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-'));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const config = configSchema.parse({ development: true, socket: join(folder, 'socket'), rescuePort: 8899, stateDir: folder, pollMs: 10, idleLimitMs: limit, busyStaleMs: 250, statusOnly });
  // Port 8899 belongs to this fixture's rescue listener, never a live service:
  // profile probes aim there so nothing outside the 8890–8899 block is called.
  const registry = buildRegistry(adopt).map(entry => ({
    ...entry, health: { kind: 'none' as const }, busy: { kind: 'none' as const }, holdFile: undefined,
    ...(entry.profiles ? { profiles: entry.profiles.map(profile => ({ ...profile, health: { kind: 'http' as const, url: 'http://127.0.0.1:8899/health', timeoutMs: 30 } })) } : {}),
  }));
  const keys = [{ name: 'demo-server', scope: 'server' as const, sha256: hashKey('fake-server-key') }, { name: 'demo-rescue', scope: 'rescue' as const, sha256: hashKey('fake-rescue-key') }];
  exec = isolatedExec(exec);
  const actions = new Actions(registry, exec, config, busy, trustAny);
  const server = createSupervisor({ config, registry, keys, exec, actions });
  if (listen) { await server.start(); cleanups.push(() => server.close()); }
  function call(key: string, body?: unknown, tcp = false, path = '/v1/status'): Promise<{ code: number; body: Record<string, any> }> {
    return new Promise((resolve, reject) => {
      const req = request({ ...(tcp ? { host: '127.0.0.1', port: 8899 } : { socketPath: config.socket }), path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + key } }, res => {
        let data = '';
        res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ code: res.statusCode!, body: data ? JSON.parse(data) : {} }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { folder, config, registry, actions, server, call };
}
async function finished(actions: Actions) {
  for (let count = 0; actions.running && count < 400; count++) await delay(5);
  expect(actions.running).toBeUndefined();
}
describe('supervisor acceptance', () => {
  it('status-only refuses every action over both listeners while keeping status available', async () => {
    const calls: string[][] = [];
    const { call, actions, folder } = await fixture({ async run(argv) { calls.push([...argv]); return 0; } }, undefined, 200, true, ADOPT, true);
    expect((await call('fake-server-key')).code).toBe(200);
    expect((await call('fake-rescue-key', undefined, true)).code).toBe(200);
    expect((await call('fake-server-key')).body.components.every((entry: { actions: unknown[] }) => entry.actions.length === 0)).toBe(true);
    for (const verb of ['start', 'stop', 'restart', 'hold', 'release', 'switch-model', 'diagnostics'] as const) {
      const body = { verb, target: verb === 'switch-model' ? 'main-model' : 'coder', ...(verb === 'switch-model' ? { profile: 'balanced' } : {}) };
      const result = await call('fake-server-key', body, false, '/v1/actions');
      expect(result.code).toBe(403); expect(result.body.message).toContain('status-only');
      expect(() => actions.start(body, 'demo-server')).toThrow('status-only');
      expect((await call('fake-rescue-key', body, true, '/v1/actions')).code).toBe(403);
    }
    expect((await call('fake-rescue-key', { verb: 'restart', target: 'wayroost-server' }, true, '/v1/actions')).code).toBe(403);
    expect(calls).toEqual([]); expect(actions.running).toBeUndefined(); expect(actions.records.size).toBe(0);
    await expect(readFile(join(folder, 'audit.jsonl'))).rejects.toThrow();
  });
  it('1: authenticates keys and restricts both listeners and rescue verbs', async () => {
    const { call, actions } = await fixture();
    expect((await call('unknown')).code).toBe(401);
    expect((await call('fake-server-key')).code).toBe(200);
    expect((await call('fake-server-key', undefined, true)).code).toBe(403);
    expect((await call('fake-rescue-key')).code).toBe(403);
    expect((await call('fake-rescue-key', undefined, true)).code).toBe(200);
    for (const verb of ['start', 'stop', 'hold', 'release', 'switch-model', 'diagnostics', 'restart']) {
      const body = { verb, target: verb === 'switch-model' ? 'main-model' : 'wayroost-server', ...(verb === 'switch-model' ? { profile: 'balanced' } : {}) };
      if (verb === 'restart') continue;
      expect((await call('fake-rescue-key', body, true, '/v1/actions')).code).toBe(403);
    }
    expect((await call('fake-rescue-key', { verb: 'restart', target: 'coder' }, true, '/v1/actions')).code).toBe(403);
    expect((await call('fake-rescue-key', { verb: 'restart', target: 'wayroost-server' }, true, '/v1/actions')).code).toBe(202);
    await finished(actions);
    expect((await call('fake-rescue-key', undefined, true, '/v1/actions/fake-id')).code).toBe(403);
  });
  it('2: rejects unknown verbs, targets, profiles and injected fields; uses fixed argv', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const { call, actions } = await fixture({ async run(argv) { mutableCalls.push([...argv]); return 0; } });
    for (const body of [
      { verb: 'shell', target: 'coder' }, { verb: 'restart', target: '; echo fake' },
      { verb: 'switch-model', target: 'main-model', profile: 'unknown' },
      { verb: 'switch-model', target: 'main-model' },
      { verb: 'restart', target: 'coder', argv: ['echo', 'injection'] },
      { verb: 'restart', target: 'coder', profile: 'balanced' },
    ]) {
      const result = await call('fake-server-key', body, false, '/v1/actions');
      expect(result.code).toBe(400); expect(result.body.message).toEqual(expect.any(String));
    }
    expect(calls).toHaveLength(0);
    expect((await call('fake-server-key', { verb: 'switch-model', target: 'main-model', profile: 'balanced' }, false, '/v1/actions')).code).toBe(202);
    await finished(actions);
    expect(calls[0]?.slice(0, 1)).toEqual(['systemd-run']);
    expect(calls[0]?.slice(2)).toEqual(['--property=CollectMode=inactive', '--property=KillMode=process', '--wait', '--quiet', expect.stringContaining('StandardOutput=append:'), expect.stringContaining('StandardError=append:'), '--', '/demo/bin/launch.sh', 'balanced']);
  });
  it('3: rejects a second lifecycle action with the running action', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { call, actions } = await fixture({ async run() { await gate; return 0; } });
    const first = await call('fake-server-key', { verb: 'restart', target: 'coder' }, false, '/v1/actions');
    const second = await call('fake-server-key', { verb: 'restart', target: 'paseo' }, false, '/v1/actions');
    expect(second.code).toBe(409); expect(second.body.error).toBe('busy');
    expect(second.body.running.id).toBe(first.body.actionId);
    release(); await finished(actions);
  });
  it('4: waits while busy, then runs; fails plainly after the idle limit', async () => {
    let busy = true; let count = 0;
    const exec = { async run() { count++; return 0; } };
    // A generous idle limit for the waiting half, so a loaded machine can't
    // turn "still waiting" into "stayed busy too long" before the check.
    const { actions } = await fixture(exec, async () => busy, 10_000, false);
    const action = await actions.start({ verb: 'restart', target: 'coder', when: 'idle' }, 'demo-server');
    await delay(25); expect(action.state).toBe('waiting-for-idle'); expect(count).toBe(0);
    busy = false; await finished(actions); expect(count).toBe(1); expect(action.state).toBe('done');
    busy = true;
    const short = await fixture(exec, async () => busy, 70, false);
    const timeout = await short.actions.start({ verb: 'restart', target: 'coder', when: 'idle' }, 'demo-server');
    await finished(short.actions); expect(timeout.state).toBe('failed'); expect(timeout.result).toContain('stayed busy too long'); expect(count).toBe(1);
  });
  it('5: streams status, action and output lines as SSE', async () => {
    const { config, call, actions } = await fixture();
    let data = '';
    let received!: () => void;
    const lineSeen = new Promise<void>(resolve => { received = resolve; });
    const req = request({ socketPath: config.socket, path: '/v1/events', headers: { authorization: 'Bearer fake-server-key' } }, res => {
      expect(res.headers['content-type']).toBe('text/event-stream');
      res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; if (data.includes('event: line\n')) received(); });
    });
    req.end(); cleanups.push(async () => { req.destroy(); });
    await delay(20);
    await call('fake-server-key', { verb: 'restart', target: 'coder' }, false, '/v1/actions');
    await lineSeen; await finished(actions);
    expect(data).toContain('event: status\ndata: {"type":"status"');
    expect(data).toContain('event: action\ndata: {"type":"action"');
    expect(data).toContain('event: line\ndata: {"type":"line"');
    expect(data).toContain('\n\n');
    const events = data.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\ndata: ')[1]!));
    expect(events.some(event => event.type === 'line' && event.line === 'demo output')).toBe(true);
  });
  it('rescue events carry only status while the server receives unrelated action output', async () => {
    const { config, server, actions, call } = await fixture();
    const openEvents = (rescue: boolean) => new Promise<{ frames: string[]; waitForStatus: (at: number) => Promise<void> }>((resolve, reject) => {
      const frames: string[] = [];
      const waiting = new Map<number, () => void>();
      let pending = '';
      const req = request({ ...(rescue ? { host: '127.0.0.1', port: config.rescuePort } : { socketPath: config.socket }),
        path: '/v1/events', headers: { authorization: 'Bearer fake-' + (rescue ? 'rescue' : 'server') + '-key' } }, res => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', chunk => {
          pending += String(chunk);
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            frames.push(frame);
            const event = JSON.parse(frame.split('\ndata: ')[1]!) as { type: string; status?: { at: number } };
            if (event.type === 'status') {
              waiting.get(event.status!.at)?.(); waiting.delete(event.status!.at);
              resolve({ frames, waitForStatus: at => new Promise<void>(done => { waiting.set(at, done); }) });
            }
          }
        });
      });
      req.on('error', reject); req.end(); cleanups.push(async () => { req.destroy(); });
    });
    const serverEvents = await openEvents(false);
    const rescueEvents = await openEvents(true);
    const action = { id: 'obviously-fake-unrelated-action', verb: 'restart' as const, target: 'coder', state: 'running' as const,
      caller: 'demo-server', startedAt: 1, lines: ['demo action output'], result: 'demo result' };
    expect((await call('fake-rescue-key', undefined, true, '/v1/actions/' + action.id)).code).toBe(403);
    const at = 42;
    const received = Promise.all([serverEvents.waitForStatus(at), rescueEvents.waitForStatus(at)]);
    actions.emitEvent({ type: 'action', action });
    actions.emitEvent({ type: 'line', actionId: action.id, line: 'demo action output' });
    actions.emitEvent({ type: 'status', status: { ...await server.status(), at, running: action } });
    await received;
    expect(serverEvents.frames.some(frame => frame.startsWith('event: action\n'))).toBe(true);
    expect(serverEvents.frames.some(frame => frame.startsWith('event: line\n') && frame.includes('demo action output'))).toBe(true);
    expect(rescueEvents.frames.every(frame => frame.startsWith('event: status\n'))).toBe(true);
    const rescueStatus = JSON.parse(rescueEvents.frames.find(frame => frame.includes('"at":42'))!.split('\ndata: ')[1]!);
    expect(rescueStatus.status.running).toEqual({ ...action, lines: undefined, result: undefined });
    expect(rescueEvents.frames.join('\n')).not.toContain('demo action output');
    expect(rescueEvents.frames.join('\n')).not.toContain('demo result');
  });
  it('6: audits only metadata and keeps output in separate action logs', async () => {
    const { folder, actions } = await fixture(undefined, async () => false, 200, false);
    const action = await actions.start({ verb: 'restart', target: 'coder' }, 'demo-server');
    await finished(actions);
    const text = await readFile(join(folder, 'audit.jsonl'), 'utf8');
    expect(text).not.toContain('fake-server-key'); expect(text).not.toContain(hashKey('fake-server-key')); expect(text).not.toContain('demo output');
    expect(JSON.parse(text)).toEqual({ id: action.id, time: expect.any(String), caller: 'demo-server', verb: 'restart', target: 'coder', profile: null, outcome: 'done' });
    expect(await readFile(join(folder, 'actions', action.id + '.log'), 'utf8')).toBe('demo output\n');
  });
  it('6: writes one audit line per action, ended by a real newline, parseable line by line', async () => {
    const { folder, actions } = await fixture(undefined, async () => false, 200, false);
    await actions.start({ verb: 'restart', target: 'coder' }, 'demo-server'); await finished(actions);
    await actions.start({ verb: 'stop', target: 'signalbox' }, 'demo-rescue'); await finished(actions);
    const text = await readFile(join(folder, 'audit.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe('');
    const rows = lines.slice(0, -1).map(line => JSON.parse(line));
    expect(rows.map(row => [row.verb, row.target, row.outcome])).toEqual([['restart', 'coder', 'done'], ['stop', 'signalbox', 'done']]);
  });
  it('4: gates when:idle on POST /v1/busy; stale counts are unknown, treated as busy but bounded', async () => {
    let count = 0;
    const { call, actions, config } = await fixture({ async run() { count++; return 0; } }, undefined, 150);
    expect((await call('fake-rescue-key', { paseoRunning: 0, hermesRunning: 0, calls: 0 }, true, '/v1/busy')).code).toBe(403);
    expect((await call('fake-server-key', { paseoRunning: 0, hermesRunning: 0, calls: 0, extra: true }, false, '/v1/busy')).code).toBe(400);
    expect((await call('fake-server-key', { paseoRunning: -1 }, false, '/v1/busy')).code).toBe(400);
    expect(actions.busy.state()).toBe('unknown');
    expect((await call('fake-server-key', { paseoRunning: 1, hermesRunning: 0, calls: 0 }, false, '/v1/busy')).code).toBe(204);
    expect(actions.busy.state()).toBe('busy');
    const action = await actions.start({ verb: 'restart', target: 'coder', when: 'idle' }, 'demo-server');
    await delay(30); expect(action.state).toBe('waiting-for-idle'); expect(count).toBe(0);
    await call('fake-server-key', { paseoRunning: 0, hermesRunning: 0, calls: 0 }, false, '/v1/busy');
    await finished(actions); expect(count).toBe(1); expect(action.state).toBe('done');
    // After the stale window the counts are unknown again — busy for waiting, bounded by the limit.
    await delay(config.busyStaleMs + 10);
    expect(actions.busy.state()).toBe('unknown');
    const stuck = await actions.start({ verb: 'restart', target: 'coder', when: 'idle' }, 'demo-server');
    await finished(actions);
    expect(stuck.state).toBe('failed'); expect(stuck.result).toContain('stayed busy too long'); expect(count).toBe(1);
    await call('fake-server-key', { paseoRunning: 0, hermesRunning: 0, calls: 0 }, false, '/v1/busy');
    const done = await actions.start({ verb: 'restart', target: 'coder', when: 'idle' }, 'demo-server');
    await finished(actions); expect(done.state).toBe('done'); expect(count).toBe(2);
    expect((await call('fake-server-key')).body.busy).toBe('idle');
  });
  it('diagnostics returns versions, unit states and health results as one JSON object', async () => {
    const { call, actions } = await fixture({ async run(argv, line) { if (argv[argv.indexOf('--') + 1] === 'systemctl' && argv.includes('is-active')) line?.('active'); return 0; } });
    const started = await call('fake-server-key', { verb: 'diagnostics', target: 'signalbox' }, false, '/v1/actions');
    expect(started.code).toBe(202);
    await finished(actions);
    const detail = (await call('fake-server-key', undefined, false, '/v1/actions/' + started.body.actionId)).body;
    expect(detail.state).toBe('done');
    expect(detail.lines).toEqual([]);
    const report = JSON.parse(detail.result);
    expect(report.versions).toEqual({ node: process.version, supervisor: '0.1.0' });
    const row = report.components.find((entry: { id: string }) => entry.id === 'signalbox');
    expect(row.unit).toBe('signalbox.service'); expect(row.unitState).toBe('active');
    const model = report.components.find((entry: { id: string }) => entry.id === 'main-model');
    expect(model.health).toEqual({ 'main-model': 'no answer', 'fast': 'no answer', 'balanced': 'no answer', 'large': 'no answer' });
    expect(JSON.stringify(report)).not.toContain('demo output');
    expect(JSON.stringify(report)).not.toContain('fake-server-key');
  });
  it('registry is site-neutral, derives unit argv, and takes site paths from config', () => {
    expect(JSON.stringify(BUILTIN_COMPONENTS)).not.toMatch(/\/opt\/|\/usr\//);
    const bare = buildRegistry();
    expect(isReady(bare.find(entry => entry.id === 'signalbox')!)).toBe(true);
    expect(bare.find(entry => entry.id === 'signalbox')!.restart).toEqual(['systemctl', 'restart', 'signalbox.service']);
    // The launcher-backed components wait for supervisor.json.
    for (const id of ['main-model', 'coder', 'paseo']) expect(isReady(bare.find(entry => entry.id === id)!)).toBe(false);
    const adopt = buildRegistry(ADOPT);
    expect(adopt.find(entry => entry.id === 'main-model')!.stop).toEqual(['/demo/bin/launch.sh', 'stop-model']);
    expect(adopt.find(entry => entry.id === 'main-model')!.profiles![2]!.argv).toEqual(['/demo/bin/launch.sh', 'balanced']);
    expect(adopt.find(entry => entry.id === 'coder')!.start).toEqual(['/demo/bin/launch-vllm.sh', 'coder']);
    expect(adopt.find(entry => entry.id === 'coder')!.holdFile).toBe('/demo/state/coder-hold');
    expect(adopt.find(entry => entry.id === 'paseo')!.restart).toEqual(['/demo/bin/launch.sh', 'restart-paseo']);
    // A user unit targets its user through -M, exactly as the contract of adopt mode states.
    const patched = buildRegistry({}, [{ id: 'hermes-gateway', unit: { name: 'demo-gateway.service', scope: 'user', user: 'demo' } }]);
    expect(patched.find(entry => entry.id === 'hermes-gateway')!.restart).toEqual(['systemctl', '--user', '-M', 'demo@', 'restart', 'demo-gateway.service']);
    expect(patched.find(entry => entry.id === 'hermes-gateway')!.health).toEqual({ kind: 'unit', command: ['systemctl', '--user', '-M', 'demo@', 'is-active', '--quiet', 'demo-gateway.service'] });
  });
  it('status leaves unset components out and says they are not set up', async () => {
    const { call } = await fixture(undefined, async () => false, 200, true, {});
    const status = (await call('fake-server-key')).body;
    for (const id of ['main-model', 'coder', 'paseo']) {
      expect(status.components.some((entry: { id: string }) => entry.id === id)).toBe(false);
      expect(status.notSetUp.some((entry: { id: string; sentence: string }) => entry.id === id && entry.sentence === 'Not set up on this PC.')).toBe(true);
    }
    const rejected = await call('fake-server-key', { verb: 'restart', target: 'coder' }, false, '/v1/actions');
    expect(rejected.code).toBe(400); expect(rejected.body.message).toBe('Not set up on this PC.');
  });
  it('the live model is the profile whose health answers', async () => {
    const model = createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 503, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>(resolve => model.listen(8898, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => model.close(() => resolve())));
    const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-'));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const registry = buildRegistry({ launchScript: '/demo/bin/launch.sh' }).map(entry => ({
      ...entry, health: { kind: 'none' as const }, busy: { kind: 'none' as const }, holdFile: undefined,
      // Only the first profile answers; the rest hit ports nothing holds in this block.
      ...(entry.profiles ? { profiles: entry.profiles.map((profile, index) => ({ ...profile, health: { kind: 'http' as const, url: `http://127.0.0.1:8898/${index === 0 ? 'health' : 'unavailable'}`, timeoutMs: 30 } })) } : {}),
    }));
    const config = configSchema.parse({ development: true, socket: join(folder, 'socket'), rescuePort: 8899, stateDir: folder });
    const supervisor = createSupervisor({ config, registry, keys: [{ name: 'demo-server', scope: 'server', sha256: hashKey('fake-server-key') }], exec: { async run() { return 0; } } });
    cleanups.push(() => supervisor.close().catch(() => {}));
    const main = (await supervisor.status()).components.find(entry => entry.id === 'main-model')!;
    expect(main.state).toBe('up');
    expect(main.model?.live).toBe('main-model');
    expect(main.sentence).toBe('Main model is answering.');
    expect(main.model?.profiles.every(profile => !('health' in profile) && !('argv' in profile))).toBe(true);
  });
  it('validates config, key files and registry overrides strictly', async () => {
    const { folder } = await fixture(undefined, undefined, 200, false);
    expect(() => configSchema.parse({ development: true, rescueHost: '0.0.0.0' })).toThrow();
    expect(() => configSchema.parse({ development: true, unknown: true })).toThrow();
    expect(() => configSchema.parse({ development: true, adopt: { unknown: '/demo/bin/x' } })).toThrow();
    expect(() => configSchema.parse({ development: true, adopt: { launchScript: 'launch.sh' } })).toThrow();
    const path = join(folder, 'components.local.json');
    await writeFile(path, JSON.stringify([{ id: 'signalbox', name: 'Demo relay', restart: ['demo', 'restart'] }]));
    const registry = await loadRegistry(path);
    expect(registry.find(entry => entry.id === 'signalbox')?.restart).toEqual(['demo', 'restart']);
    expect(registry.find(entry => entry.id === 'signalbox')?.stop).toEqual(BUILTIN_COMPONENTS.find(entry => entry.id === 'signalbox')?.stop);
    expect(registry.find(entry => entry.id === 'main-model')?.start).toBeUndefined();
    await writeFile(path, JSON.stringify([{ id: 'signalbox', restart: 'demo restart' }]));
    await expect(loadRegistry(path)).rejects.toThrow();
    await writeFile(path, JSON.stringify([{ name: 'demo', scope: 'server', sha256: 'bad' }]));
    await expect(loadKeys(path)).rejects.toThrow();
    expect(authenticate('fake', [{ name: 'demo', scope: 'server', sha256: hashKey('fake') }])?.name).toBe('demo');
  });
  it('probes units through Exec and treats failed busy HTTP probes conservatively', async () => {
    const calls: string[][] = [];
    expect(await probe({ kind: 'unit', command: ['systemctl', 'is-active', '--quiet', 'demo.service'] }, { async run(argv) { calls.push([...argv]); return 0; } })).toBe(true);
    expect(calls).toEqual([['systemctl', 'is-active', '--quiet', 'demo.service']]);
    // Port 8899 belongs to this test's fake HTTP server, never a live service.
    await fixture();
    expect(await probe({ kind: 'http', url: 'http://127.0.0.1:8899/v1/status', timeoutMs: 30 }, { async run() { return 1; } })).toBe(false);
    expect(await probe({ kind: 'http', url: 'http://127.0.0.1:8899/v1/status', timeoutMs: 30, busyField: 'busy' }, { async run() { return 1; } }, true)).toBe(true);
  });
  it('restores the lifecycle lock before either listener accepts actions', async () => {
    const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-'));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    await mkdir(join(folder, 'actions'));
    const record = { id: 'obviously-fake-running', verb: 'restart', target: 'demo', caller: 'demo-caller', state: 'running', startedAt: 1 };
    await writeFile(join(folder, 'actions', record.id + '.json'), JSON.stringify(record));
    const config = configSchema.parse({ development: true, socket: join(folder, 'socket'), stateDir: folder, rescuePort: 8899, statusOnly: false, pollMs: 2 });
    const entry = { id: 'demo', name: 'Demo', health: { kind: 'none' as const }, busy: { kind: 'none' as const }, gpus: [], start: ['demo'], restart: ['demo'] };
    let launched = 0;
    const supervisor = createSupervisor({ config, registry: [entry], keys: [{ name: 'demo', scope: 'server', sha256: hashKey('fake-server-key') }],
      exec: { async run(argv, line) {
        if (argv.includes('list-units')) line?.('wayroost-act-obviously-fake-running.service loaded active running Demo');
        if (argv.includes('show')) line?.('ActiveState=active');
        if (argv[0] === 'systemd-run') launched++;
        return 0;
      } } });
    await supervisor.start(); cleanups.push(() => supervisor.close());
    const response = await new Promise<{ code: number; body: any }>((resolve, reject) => {
      const req = request({ socketPath: config.socket, path: '/v1/actions', method: 'POST', headers: { authorization: 'Bearer fake-server-key' } }, res => {
        let body = ''; res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => resolve({ code: res.statusCode!, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.end(JSON.stringify({ verb: 'restart', target: 'demo' }));
    });
    expect(response.code).toBe(409); expect(response.body.running.id).toBe(record.id);
    expect(response.body.running).not.toHaveProperty('lines'); expect(launched).toBe(0);
  });
  it('keeps a reading SSE client connected through a 128 KiB frame and drain', async () => {
    const { config, actions } = await fixture();
    let data = ''; let statusSeen!: () => void; let laterSeen!: () => void;
    const status = new Promise<void>(resolve => { statusSeen = resolve; });
    const later = new Promise<void>(resolve => { laterSeen = resolve; });
    const req = request({ socketPath: config.socket, path: '/v1/events', headers: { authorization: 'Bearer fake-server-key' } }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.includes('event: status')) statusSeen(); if (data.includes('after-drain')) laterSeen(); });
    });
    req.end(); cleanups.push(async () => { req.destroy(); });
    await status;
    actions.emitEvent({ type: 'line', actionId: 'obviously-fake-action', line: 'x'.repeat(131072) });
    actions.emitEvent({ type: 'line', actionId: 'obviously-fake-action', line: 'after-drain' });
    await later;
    expect(data).toContain('x'.repeat(131072)); expect(req.destroyed).toBe(false);
  });

});
