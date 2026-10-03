import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { request, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionDetail, SupervisorEvent } from '../../shared/supervisor.js';
import { Actions, BusyError, summary } from '../src/actions.js';
import { configSchema } from '../src/config.js';
import { changeHold } from '../src/hold.js';
import { HISTORY_SIZE, LINE_LENGTH, OUTPUT_LINES, OutputTail, retainLine } from '../src/output.js';
import { CLEANUP_LIMIT_MS, KILL_GRACE_MS, installation, probe, realExec, spawnExec, type Exec } from '../src/probes.js';
import { buildRegistry, isReady, type Component } from '../src/registry.js';
import { createSupervisor } from '../src/server.js';
import { hashKey } from '../src/keys.js';
import { prepareSocketDirectory, recoverSocket } from '../src/socket.js';
import { EventStream, SSE_BUFFER_BYTES } from '../src/sse.js';
import { unitArgv } from '../src/unit.js';
import { trustAny } from './fixtures.js';
import { trustedExecutable } from '../src/trust.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof fs>();
  return { ...original, appendFile: vi.fn(original.appendFile) };
});

const cleanups: (() => Promise<unknown>)[] = [];
/** Model trusted system-file ownership explicitly, including in UID-remapping sandboxes. */
function rootOwnedSystemFiles() {
  const lstat = fs.lstat;
  const paths = new Set(['/', '/usr', '/usr/bin', '/bin', '/usr/bin/sh', '/usr/bin/dash', '/usr/bin/true', '/usr/bin/false']);
  vi.spyOn(fs, 'lstat').mockImplementation(async path => {
    const info = await lstat(path);
    return paths.has(String(path)) ? Object.assign(info, { uid: 0 }) : info;
  });
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const demo = (): Component => ({ id: 'demo', name: 'Demo', health: { kind: 'none' }, busy: { kind: 'none' }, gpus: [],
  start: ['demo', 'start'], restart: ['demo', 'restart'], stop: ['demo', 'stop'] });
async function fixture(exec: Exec = { async run() { return 0; } }, busy?: () => Promise<boolean>, idleLimitMs = 30) {
  const folder = await fs.mkdtemp(join(process.cwd(), '.supervisor-resilience-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), rescuePort: 8899, statusOnly: false, pollMs: 2, idleLimitMs });
  const actions = new Actions([demo()], exec, config, busy, trustAny);
  cleanups.push(() => actions.close());
  return { folder, config, actions };
}
/** `systemctl show` as real systemd answers it: a unit that is gone still exits 0, with defaults. */
function show(line: ((line: string) => void) | undefined, unit?: { active: string; result?: string; status?: string }) {
  if (!unit) for (const row of ['LoadState=not-found', 'InvocationID=', 'ActiveState=inactive', 'Result=success', 'ExecMainStatus=0']) line?.(row);
  else for (const row of ['LoadState=loaded', 'InvocationID=0123456789abcdef0123456789abcdef', 'ActiveState=' + unit.active,
    'Result=' + (unit.result ?? 'success'), 'ExecMainStatus=' + (unit.status ?? '0')]) line?.(row);
  return 0;
}
async function until(predicate: () => boolean) {
  for (let count = 0; !predicate() && count < 500; count++) await delay(2);
  expect(predicate()).toBe(true);
}

it('keeps lifecycle state in a dedicated temporary directory', async () => {
  const { folder } = await fixture();
  expect(folder).toContain('.supervisor-resilience-');
});

it('refuses hold-file and parent symlinks for hold and release', async () => {
  const { folder } = await fixture();
  const victim = join(folder, 'victim'); const hold = join(folder, 'hold');
  await fs.symlink(victim, hold);
  for (const verb of ['hold', 'release'] as const) await expect(changeHold(hold, verb)).rejects.toThrow();
  await expect(fs.stat(victim)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.writeFile(victim, 'unchanged');
  await expect(changeHold(hold, 'hold')).rejects.toThrow();
  expect(await fs.readFile(victim, 'utf8')).toBe('unchanged');
  const actual = join(folder, 'actual'); await fs.mkdir(actual);
  await fs.symlink(actual, join(folder, 'linked'));
  await expect(changeHold(join(folder, 'linked', 'hold'), 'hold')).rejects.toThrow();
  await fs.unlink(hold);
  await changeHold(hold, 'hold'); expect((await fs.stat(hold)).isFile()).toBe(true);
  await changeHold(hold, 'release'); await changeHold(hold, 'release');
  await expect(fs.stat(hold)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.mkdir(hold); await expect(changeHold(hold, 'release')).rejects.toThrow();
});

it('output keeps flowing through file descriptors after the supervisor process is killed', async () => {
  const { folder } = await fixture();
  const writer = "process.stdout.write('before\\n'); process.stderr.write('stderr before\\n'); setTimeout(()=>{process.stdout.write('after\\n'); process.stderr.write('stderr after\\n');},250);";
  const script = `
    import { spawn } from 'node:child_process';
    import { openSync, closeSync } from 'node:fs';
    import { Actions } from './supervisor/src/actions.ts';
    import { configSchema } from './supervisor/src/config.ts';
    const exec = { async run(argv) {
      if (argv[0] !== 'systemd-run') return 0;
      const log = argv.find(arg=>arg.startsWith('--property=StandardOutput=append:')).split('append:')[1];
      const fd = openSync(log, 'a');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {detached:true, stdio:['ignore',fd,fd]});
      closeSync(fd); child.unref(); process.stdout.write('started\\n');
      return new Promise(()=>{});
    }};
    const actions = new Actions([{id:'demo',name:'Demo',health:{kind:'none'},busy:{kind:'none'},gpus:[],start:['demo'],restart:['demo']}], exec,
      configSchema.parse({ development: true,stateDir:process.argv[1],statusOnly:false,pollMs:2}), undefined, async command => command);
    await actions.start({verb:'restart',target:'demo'},'demo');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, folder], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve()); child.once('error', reject);
    child.once('exit', code => { if (code !== null) reject(new Error(errors || 'supervisor exited early')); });
  });
  const files = await fs.readdir(join(folder, 'actions')); const log = join(folder, 'actions', files.find(file => file.endsWith('.log'))!);
  for (let count = 0; !(await fs.readFile(log, 'utf8')).includes('stderr before') && count < 500; count++) await delay(2);
  expect(await fs.readFile(log, 'utf8')).toContain('stderr before');
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  await delay(300);
  expect(await fs.readFile(log, 'utf8')).toBe('before\nstderr before\nafter\nstderr after\n');
});

it('uses file-backed transient stdout and stderr and tails output', async () => {
  let invocation: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const exec: Exec = { async run(argv) {
    if (argv[0] !== 'systemd-run') return 0;
    invocation = [...argv];
    const path = argv.find(arg => arg.startsWith('--property=StandardOutput=append:'))!.split('append:')[1]!;
    await fs.appendFile(path, 'before restart\n'); await gate;
    await fs.appendFile(path, 'after restart\n'); return 0;
  } };
  const { actions, folder } = await fixture(exec);
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo-caller');
  await until(() => action.lines.includes('before restart'));
  expect(invocation).not.toContain('--pipe');
  expect(invocation).toContain('--property=StandardOutput=append:' + join(folder, 'actions', action.id + '.log'));
  expect(invocation).toContain('--property=StandardError=append:' + join(folder, 'actions', action.id + '.log'));
  await actions.close(); release(); await delay(15);
  expect(await fs.readFile(join(folder, 'actions', action.id + '.log'), 'utf8')).toBe('before restart\nafter restart\n');
});

it('persists before launching and recovers the lock, caller and outcome after restart', async () => {
  let live = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saved: Record<string, unknown> | undefined;
  let currentId = '';
  let folder = '';
  const exec: Exec = { async run(argv, line) {
    if (argv[0] === 'systemd-run') {
      currentId = argv.find(arg => arg.startsWith('--unit='))!.slice('--unit=wayroost-act-'.length);
      saved = JSON.parse(await fs.readFile(join(folder, 'actions', currentId + '.json'), 'utf8'));
      live = true; await gate; return 0;
    }
    if (argv.includes('list-units') && live) line?.(`wayroost-act-${currentId}.service loaded active running Demo`);
    // Once it finishes, the collected unit is gone: its outcome is unknown, never a success.
    if (argv.includes('show')) return show(line, live ? { active: 'active' } : undefined);
    return 0;
  } };
  const first = await fixture(exec); folder = first.folder;
  const action = await first.actions.start({ verb: 'restart', target: 'demo' }, 'demo-caller');
  await until(() => live);
  expect(saved).toMatchObject({ id: action.id, caller: 'demo-caller', verb: 'restart', target: 'demo', state: 'running' });
  expect(saved).not.toHaveProperty('lines');
  await first.actions.close();
  const restarted = new Actions([demo()], exec, first.config); cleanups.push(() => restarted.close());
  await restarted.initialize();
  expect(restarted.running?.id).toBe(action.id);
  expect(() => restarted.start({ verb: 'stop', target: 'demo' }, 'demo-next')).toThrow(BusyError);
  live = false; release();
  await until(() => !restarted.running);
  expect((await restarted.get(action.id))?.state).toBe('failed');
  expect((await restarted.get(action.id))?.result).toContain('outcome could be recovered');
  const audit = (await fs.readFile(join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  expect(audit).toEqual([expect.objectContaining({ id: action.id, caller: 'demo-caller', outcome: 'failed' })]);
  await restarted.close();
  const third = new Actions([demo()], exec, first.config); cleanups.push(() => third.close());
  await third.initialize();
  expect((await fs.readFile(join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
});

it('keeps all orphan unit locks and fails closed when reconciliation is unavailable', async () => {
  const live = new Set(['obviously-fake-one', 'obviously-fake-two']);
  const { config } = await fixture();
  const actions = new Actions([demo()], { async run(argv, line) {
    if (argv.includes('list-units')) for (const id of live) line?.(`wayroost-act-${id}.service loaded active running Demo`);
    if (argv.includes('show')) {
      const id = argv[2]!.slice('wayroost-act-'.length, -'.service'.length);
      return show(line, live.has(id) ? { active: 'active' } : undefined);
    }
    return 0;
  } }, config); cleanups.push(() => actions.close());
  await actions.initialize(); expect(actions.running).toBeDefined();
  live.delete('obviously-fake-one'); await until(() => actions.records.get('obviously-fake-one')?.state === 'failed');
  expect(() => actions.start({ verb: 'restart', target: 'demo' }, 'demo')).toThrow(BusyError);
  live.clear(); await until(() => !actions.running);
  const broken = new Actions([demo()], { async run() { return 1; } }, config);
  await expect(broken.start({ verb: 'restart', target: 'demo' }, 'demo')).rejects.toThrow('could not be checked');
});

it('retains the lock after a failed launcher client and recovers collected units', async () => {
  let live = false; let unitId = ''; let managerUnavailable = false;
  const exec: Exec = { async run(argv, line) {
    if (argv[0] === 'systemd-run') { live = true; unitId = argv[1]!.slice('--unit=wayroost-act-'.length); return 1; }
    if (managerUnavailable) return 1;
    if (argv.includes('list-units') && live) line?.(`wayroost-act-${unitId}.service loaded active running Demo`);
    if (argv.includes('show')) return 1;
    return 0;
  } };
  const { actions } = await fixture(exec);
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo');
  await until(() => live); await delay(15);
  expect(actions.running?.id).toBe(action.id);
  managerUnavailable = true; live = false; await delay(15);
  expect(() => actions.start({ verb: 'restart', target: 'demo' }, 'demo')).toThrow(BusyError);
  managerUnavailable = false; await until(() => !actions.running);
  expect(action.state).toBe('failed'); expect(action.result).toContain('outcome could be recovered');
});

it('reads the outcome of a unit kept loaded, then unloads failed units', async () => {
  let unit: { active: string; result?: string; status?: string } | undefined; let unitId = '';
  const resets: string[] = [];
  const exec: Exec = { async run(argv, line) {
    if (argv[0] === 'systemd-run') {
      unitId = argv[1]!.slice('--unit=wayroost-act-'.length);
      expect(argv).toContain('--property=CollectMode=inactive'); expect(argv).not.toContain('--collect');
      unit = { active: 'active' }; return 1; // the client fails while the unit keeps running
    }
    if (argv.includes('list-units') && unit && unit.active === 'active') line?.(`wayroost-act-${unitId}.service loaded active running Demo`);
    if (argv.includes('show')) return show(line, unit);
    if (argv.includes('reset-failed')) { resets.push(argv[2]!); unit = undefined; }
    return 0;
  } };
  const { actions } = await fixture(exec);
  const failed = await actions.start({ verb: 'restart', target: 'demo' }, 'demo');
  await until(() => unit?.active === 'active'); await delay(15);
  expect(actions.running?.id).toBe(failed.id);
  unit = { active: 'failed', result: 'exit-code', status: '1' };
  await until(() => !actions.running);
  expect(failed.state).toBe('failed'); expect(resets).toEqual(['wayroost-act-' + failed.id + '.service']);
  const succeeded = await actions.start({ verb: 'restart', target: 'demo' }, 'demo');
  await until(() => unit?.active === 'active'); await delay(15);
  unit = { active: 'inactive' };
  await until(() => !actions.running);
  expect(succeeded.state).toBe('done'); expect(resets).toHaveLength(1);
});

it('reconciles interrupted queued records and retries missing audits', async () => {
  const { config, folder } = await fixture();
  await fs.mkdir(join(folder, 'actions'));
  const record = { id: 'obviously-fake-queued', caller: 'demo', verb: 'restart', target: 'demo', startedAt: 1, state: 'queued', when: 'idle' };
  await fs.writeFile(join(folder, 'actions', record.id + '.json'), JSON.stringify(record));
  const actions = new Actions([demo()], { async run() { return 0; } }, config);
  await actions.initialize();
  expect(actions.running).toBeUndefined(); expect(actions.records.get(record.id)?.state).toBe('failed');
  expect(await fs.readFile(join(folder, 'audit.jsonl'), 'utf8')).toContain('obviously-fake-queued');
});

it('close() cancels an action waiting for idle: nothing launches afterwards and the cancel is recorded', async () => {
  let busy = true; let polled = 0; const launched: string[][] = [];
  const { folder } = await fixture();
  // A long poll interval: close() must not wait for it, and no timer may keep the process alive.
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), rescuePort: 8899, statusOnly: false, pollMs: 60000, idleLimitMs: 600000 });
  const actions = new Actions([demo()], { async run(argv) { if (argv[0] === 'systemd-run') launched.push([...argv]); return 0; } }, config,
    async () => { polled++; return busy; });
  cleanups.push(() => actions.close());
  const action = await actions.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo-caller');
  await until(() => polled > 0 && action.state === 'waiting-for-idle');
  const started = Date.now(); await actions.close();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(action.state).toBe('cancelled'); expect(action.result).toContain('stopped before the action started');
  expect(JSON.parse(await fs.readFile(join(folder, 'actions', action.id + '.json'), 'utf8'))).toMatchObject({ state: 'cancelled' });
  const audit = (await fs.readFile(join(folder, 'audit.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  expect(audit).toEqual([expect.objectContaining({ id: action.id, caller: 'demo-caller', outcome: 'cancelled' })]);
  busy = false; await delay(30);
  expect(launched).toEqual([]); expect(actions.running).toBeUndefined();
  // A restarted supervisor keeps the cancel; it is not reported as lost.
  const restarted = new Actions([demo()], { async run() { return 0; } }, config); cleanups.push(() => restarted.close());
  await restarted.initialize(); expect(restarted.records.get(action.id)?.state).toBe('cancelled');
});

it('handles ENOSPC immediately while output continues, then fails in a controlled way', async () => {
  let release!: () => void; let emitted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { actions } = await fixture({ async run(argv, line) {
    if (argv[0] !== 'systemd-run') return 0;
    line?.('demo output'); emitted = true; await gate; line?.('later output'); return 0;
  } });
  const append = vi.mocked(fs.appendFile);
  append.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo');
  await until(() => emitted); await delay(20);
  expect(actions.running?.id).toBe(action.id);
  release(); await until(() => !actions.running);
  expect(action.state).toBe('failed'); expect(action.result).toContain('log could not be saved');
});

it('defaults to status-only in the schema and shipped example', async () => {
  expect(configSchema.parse({ development: true,}).statusOnly).toBe(true);
  expect(JSON.parse(await fs.readFile('deploy/supervisor.example.json', 'utf8')).statusOnly).toBe(true);
});

it('makes the socket directory group-traversable even with umask 0077', async () => {
  const { folder } = await fixture(); const socket = join(folder, 'runtime', 'socket');
  const previous = process.umask(0o077);
  try { await prepareSocketDirectory(socket); } finally { process.umask(previous); }
  expect((await fs.stat(join(folder, 'runtime'))).mode & 0o777).toBe(0o750);
  const unit = await fs.readFile('deploy/wayroost-supervisor.service', 'utf8');
  expect(unit).toContain('Group=wayroost'); expect(unit).toContain('RuntimeDirectory=wayroost'); expect(unit).toContain('RuntimeDirectoryMode=0750');
});

it('recovers a socket left by a killed process and refuses live sockets, files and symlinks', async () => {
  const { folder } = await fixture(); const path = join(folder, 'stale.socket');
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import {createServer} from 'node:net'; createServer().listen(process.argv[1],()=>process.stdout.write('ready\\n'));", path], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  expect((await fs.lstat(path)).isSocket()).toBe(true);
  await recoverSocket(path); await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  const server = createServer(); await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await expect(recoverSocket(path)).rejects.toThrow('already in use'); expect(server.listening).toBe(true);
  const file = join(folder, 'regular'); await fs.writeFile(file, 'unchanged');
  await expect(recoverSocket(file)).rejects.toThrow('supervisor-owned socket');
  const link = join(folder, 'link'); await fs.symlink(path, link);
  await expect(recoverSocket(link)).rejects.toThrow('supervisor-owned socket');
  expect(await fs.readFile(file, 'utf8')).toBe('unchanged');
});

it.each(['slow idle', 'hung'] as const)('bounds %s probes by the idle deadline before execution', async mode => {
  let commands = 0;
  const { actions } = await fixture({ async run(argv) { if (argv[0] === 'systemd-run') commands++; return 0; } },
    mode === 'hung' ? () => new Promise<boolean>(() => {}) : async () => { await delay(80); return false; }, 20);
  const action = await actions.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo');
  await until(() => !actions.running);
  expect(action.state).toBe('failed'); expect(action.result).toContain('stayed busy too long'); expect(commands).toBe(0);
});

it('merges profile overrides before deriving commands and preserves explicit argv', async () => {
  const registry = buildRegistry({ launchScript: '/home/me/demo/launch.sh' }, [{ id: 'main-model',
    profiles: [{ id: 'demo-profile', name: 'Demo', gpus: [], health: { kind: 'http', url: 'http://127.0.0.1:8898/health', timeoutMs: 30 } },
      { id: 'demo-explicit', name: 'Explicit', gpus: [], health: { kind: 'http', url: 'http://127.0.0.1:8898/health', timeoutMs: 30 }, argv: ['demo', 'explicit'] }],
    restart: ['demo', 'custom-restart'],
  }]);
  const model = registry.find(entry => entry.id === 'main-model')!;
  expect(model.start).toEqual(['/home/me/demo/launch.sh', 'demo-profile']);
  expect(model.restart).toEqual(['demo', 'custom-restart']);
  expect(model.profiles?.map(profile => profile.argv)).toEqual([['/home/me/demo/launch.sh', 'demo-profile'], ['demo', 'explicit']]);
  const repeated = buildRegistry({ launchScript: '/home/me/demo/launch.sh' }, [
    { id: 'main-model', start: ['demo', 'first'] }, { id: 'main-model', start: ['demo', 'last'], stop: ['demo', 'stop'] },
  ]).find(entry => entry.id === 'main-model')!;
  expect(repeated.start).toEqual(['demo', 'last']); expect(repeated.stop).toEqual(['demo', 'stop']);
  const { config } = await fixture(); const actions = new Actions(registry, { async run() { return 0; } }, config);
  expect(() => actions.validate({ verb: 'switch-model', target: 'main-model', profile: 'demo-profile' })).not.toThrow();
});

it('requires an owner for user units and leaves unresolved built-ins not set up', async () => {
  expect(() => unitArgv({ name: 'demo.service', scope: 'user' }, 'start')).toThrow('owner');
  const bare = buildRegistry();
  for (const id of ['hermes-dashboard', 'hermes-gateway', 'phone']) expect(isReady(bare.find(entry => entry.id === id)!)).toBe(false);
  const { config } = await fixture();
  const supervisor = createSupervisor({ config, registry: bare.map(entry => ({ ...entry, health: { kind: 'none' }, profiles: undefined })), keys: [], exec: { async run() { return 0; } } });
  expect((await supervisor.status()).notSetUp?.map(entry => entry.id)).toContain('hermes-gateway');
  const owned = buildRegistry({}, [{ id: 'hermes-gateway', unit: { name: 'demo-gateway.service', scope: 'user', user: 'demo' } }]);
  expect(owned.find(entry => entry.id === 'hermes-gateway')?.start).toEqual(['systemctl', '--user', '-M', 'demo@', 'start', 'demo-gateway.service']);
});

it('rejects and omits Paseo stop until a genuine stop is configured', async () => {
  const entry = buildRegistry({ launchScript: '/home/me/demo/launch.sh', holdDir: '/home/me/demo/logs' }).find(entry => entry.id === 'paseo')!;
  expect(entry.stop).toBeUndefined(); expect(isReady(entry)).toBe(true);
  const { config } = await fixture();
  const supervisor = createSupervisor({ config, registry: [{ ...entry, health: { kind: 'none' }, holdFile: undefined }], keys: [], exec: { async run() { return 0; } } });
  expect((await supervisor.status()).components[0]?.actions).not.toContain('stop');
  expect(() => supervisor.actions.start({ verb: 'stop', target: 'paseo' }, 'demo')).toThrow('not available');
});

class FakeResponse extends EventEmitter {
  destroyed = false; writableLength = 0; blocked = true; readonly frames: string[] = [];
  write(frame: string): boolean { this.frames.push(frame); return !this.blocked; }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}
it('waits for drain, keeps accepted frames, bounds queues and emits action summaries', async () => {
  const response = new FakeResponse(); const stream = new EventStream(response as unknown as ServerResponse);
  stream.send('x'.repeat(131072)); stream.send('later');
  expect(response.destroyed).toBe(false); expect(response.frames).toHaveLength(1);
  response.blocked = false; response.emit('drain'); expect(response.frames[1]).toBe('later');
  const slow = new FakeResponse(); const slowStream = new EventStream(slow as unknown as ServerResponse);
  slowStream.send('accepted'); slowStream.send('x'.repeat(SSE_BUFFER_BYTES + 1)); expect(slow.destroyed).toBe(true);
  const events: SupervisorEvent[] = [];
  const { actions } = await fixture({ async run(argv, line) { if (argv[0] === 'systemd-run') line?.('x'.repeat(131072)); return 0; } });
  actions.on('event', event => events.push(event));
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo'); await until(() => !actions.running);
  expect(action.lines[0]?.length).toBe(LINE_LENGTH);
  for (const event of events.filter(event => event.type === 'action')) expect(event.action).not.toHaveProperty('lines');
  expect(summary(action)).not.toHaveProperty('result');
});

it('bounds output, partial lines and completed history while older records stay readable', async () => {
  const { actions, folder, config } = await fixture();
  const retained: ActionDetail = { id: 'obviously-fake-output', verb: 'restart', target: 'demo', caller: 'demo', state: 'done', startedAt: 0, lines: [] };
  for (let count = 0; count < OUTPUT_LINES + 50; count++) retainLine(retained, 'x'.repeat(LINE_LENGTH + 100));
  expect(retained.lines).toHaveLength(OUTPUT_LINES); expect(retained.lines.every(line => line.length <= LINE_LENGTH)).toBe(true);
  const path = join(folder, 'long.log'); await fs.writeFile(path, 'x'.repeat(LINE_LENGTH * 30));
  const chunks: string[] = []; const tail = new OutputTail(path, line => chunks.push(line)); while (await tail.read(true)) {}
  expect(chunks.length).toBeGreaterThan(1); expect(chunks.every(line => line.length <= LINE_LENGTH)).toBe(true);
  await actions.initialize();
  const records = Array.from({ length: HISTORY_SIZE + 5 }, (_, index) => ({ id: 'obviously-fake-history-' + index, verb: 'restart', target: 'demo', caller: 'demo', state: 'done', startedAt: index + 1, endedAt: index + 2 }));
  for (const record of records) await fs.writeFile(join(folder, 'actions', record.id + '.json'), JSON.stringify(record));
  await fs.writeFile(join(folder, 'audit.jsonl'), records.map(record => JSON.stringify({ id: record.id })).join('\n') + '\n');
  await fs.writeFile(join(folder, 'actions', records[0]!.id + '.log'), 'older output\n');
  const restored = new Actions([demo()], { async run() { return 0; } }, config, undefined, trustAny);
  await restored.initialize(); expect(restored.records.size).toBe(HISTORY_SIZE);
  expect(restored.records.has(records[0]!.id)).toBe(false);
  expect((await restored.get(records[0]!.id))?.lines).toEqual(['older output']);
  await restored.start({ verb: 'restart', target: 'demo' }, 'demo'); await until(() => !restored.running);
  expect(restored.records.size).toBe(HISTORY_SIZE);
  expect(await restored.get('../audit')).toBeUndefined();
  const execLines: string[] = [];
  await spawnExec(trustAny).run([process.execPath, '-e', "process.stdout.write('x'.repeat(100000))"], line => execLines.push(line));
  expect(execLines.every(line => line.length <= LINE_LENGTH)).toBe(true);
});

it('treats missing and invalid busy fields as busy with fresh zero pushed counts', async () => {
  const responses = [{ error: 'temporarily unavailable' }, { count: null }, { count: '0' }, { count: -1 }, { count: 0.5 }, { count: {} }, { count: [] }, { count: false }, { count: 0 }, { count: true }, { count: 2 }];
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const value = { kind: 'http' as const, url: 'http://127.0.0.1:8898/busy', timeoutMs: 20, busyField: 'count' };
  const results: boolean[] = [];
  for (const data of responses) { fetch.mockResolvedValueOnce(new Response(JSON.stringify(data))); results.push(await probe(value, { async run() { return 0; } }, true)); }
  expect(results).toEqual([true, true, true, true, true, true, true, false, false, true, true]);
  const { config } = await fixture();
  fetch.mockImplementation(async () => new Response('{"error":"temporarily unavailable"}'));
  const actions = new Actions([{ ...demo(), busy: value }], { async run() { return 0; } }, config, undefined, trustAny);
  actions.busy.record({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
  const action = await actions.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo'); await until(() => !actions.running);
  expect(action.state).toBe('failed');
});

it('hides only uninstalled optional components and retains stopped recovery actions', async () => {
  let installed = true;
  const phone = buildRegistry({}, [{ id: 'phone', unit: { name: 'demo-phone.service', scope: 'user', user: 'demo' } }]).find(entry => entry.id === 'phone')!;
  expect(phone.installed).toEqual({ kind: 'unit', command: ['systemctl', '--user', '-M', 'demo@', 'show', '--property=LoadState', '--value', 'demo-phone.service'], expect: 'loaded', absent: 'not-found' });
  const { config } = await fixture();
  // Like real systemctl: `cat` fails over -M, and `show` exits 0 for unknown units with LoadState=not-found.
  const supervisor = createSupervisor({ config, registry: [{ ...phone, health: { kind: 'none' } }], keys: [],
    exec: { async run(argv, line) {
      if (argv.includes('-M') && argv.includes('cat')) return 1;
      if (argv.includes('show')) { line?.(installed ? 'loaded' : 'not-found'); return 0; }
      return 1;
    } } });
  const stopped = (await supervisor.status()).components[0]!;
  expect(stopped.state).toBe('down'); expect(stopped.actions).toContain('start');
  installed = false; expect((await supervisor.status()).components).toEqual([]);
});

it('reports the packaged version from emitted diagnostics', async () => {
  execFileSync('npm', ['run', '-s', 'build:supervisor'], { cwd: process.cwd(), stdio: 'pipe' });
  const script = "import { collectDiagnostics } from './dist/supervisor/supervisor/src/diagnostics.js'; process.stdout.write(JSON.stringify(await collectDiagnostics([], {run:async()=>0})));";
  const emitted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' }));
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
  expect(emitted.versions.supervisor).toBe(version); expect(emitted.versions.supervisor).not.toBe('unknown');
});

it('restarts the live model profile, never the default one, and refuses when none answers', async () => {
  // Health answers come from a stubbed fetch: no port is bound or called.
  let live = 'http://127.0.0.1:8898/balanced';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('{}', { status: url === live ? 200 : 503 })));
  const registry = buildRegistry({ launchScript: '/home/me/demo/launch.sh' }).filter(entry => entry.id === 'main-model').map(entry => ({
    ...entry, profiles: entry.profiles!.map(profile => ({ ...profile, health: { kind: 'http' as const, url: 'http://127.0.0.1:8898/' + profile.id, timeoutMs: 200 } })) as Component['profiles'],
  }));
  expect(registry[0]!.restart).toBeUndefined(); expect(isReady(registry[0]!)).toBe(true);
  const launched: string[][] = [];
  const { config } = await fixture();
  const actions = new Actions(registry, { async run(argv) { if (argv[0] === 'systemd-run') launched.push(argv.slice(argv.indexOf('--') + 1)); return 0; } }, config, undefined, trustAny);
  cleanups.push(() => actions.close());
  const restarted = await actions.start({ verb: 'restart', target: 'main-model' }, 'demo'); await until(() => !actions.running);
  expect(restarted.state).toBe('done'); expect(launched).toEqual([['/home/me/demo/launch.sh', 'balanced']]);
  live = 'none';
  const refused = await actions.start({ verb: 'restart', target: 'main-model' }, 'demo'); await until(() => !actions.running);
  expect(refused.state).toBe('failed'); expect(refused.result).toContain('no live model to restart'); expect(launched).toHaveLength(1);
});

it('runs only commands that nobody but root can change, checked at every launch', async () => {
  rootOwnedSystemFiles();
  const { folder, config } = await fixture();
  // A folder anyone may write: refused whoever runs the test, root included.
  const open = join(folder, 'open'); await fs.mkdir(open); await fs.chmod(open, 0o777);
  const script = join(open, 'launch.sh'); await fs.writeFile(script, '#!/bin/sh\n', { mode: 0o755 });
  await expect(trustedExecutable(script)).rejects.toThrow('changed by someone other than root');
  // A symlink to a root-owned file, kept in a writable folder, can be swapped.
  const link = join(open, 'linked'); await fs.symlink('/bin/sh', link);
  await expect(trustedExecutable(link)).rejects.toThrow('changed by someone other than root');
  await expect(trustedExecutable('relative/launch.sh')).rejects.toThrow('absolute path');
  await expect(trustedExecutable('obviously-fake-command-name')).rejects.toThrow('not found');
  // Root-owned system files pass, through /bin symlinks and `..`; bare names resolve to a fixed path.
  await expect(trustedExecutable('/bin/sh')).resolves.toBe('/bin/sh');
  await expect(trustedExecutable('/usr/bin/../bin/sh')).resolves.toBe('/usr/bin/../bin/sh');
  expect(await trustedExecutable('sh')).toMatch(/^\/(usr\/)?(local\/)?s?bin\/sh$/);
  await expect(trustedExecutable('/usr/bin')).rejects.toThrow('not a regular file');
  // The default Actions check refuses before systemd-run, and the action fails plainly.
  const launched: string[][] = [];
  const actions = new Actions([{ ...demo(), restart: [script, 'restart'] }], { async run(argv) {
    if (argv[0] === 'systemd-run') launched.push([...argv]); return 0;
  } }, config);
  cleanups.push(() => actions.close());
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo'); await until(() => !actions.running);
  expect(action.state).toBe('failed'); expect(action.result).toContain('Move it to a root-owned folder'); expect(launched).toEqual([]);
});

it('checks every command the production runner spawns, probes included, even in status-only mode', async () => {
  rootOwnedSystemFiles();
  const { folder, config } = await fixture();
  // A probe script anyone may replace: it must never run, whoever runs the test.
  const open = join(folder, 'open'); await fs.mkdir(open); await fs.chmod(open, 0o777);
  const marker = join(folder, 'ran'); const script = join(open, 'probe.sh');
  await fs.writeFile(script, '#!/bin/sh\ntouch ' + marker + '\n', { mode: 0o755 });
  await expect(realExec.run([script])).rejects.toThrow('changed by someone other than root');
  const untrusted = { kind: 'unit' as const, command: [script] as [string, ...string[]] };
  expect(await probe(untrusted, realExec)).toBe(false);
  expect(await probe(untrusted, realExec, true)).toBe(true);
  const supervisor = createSupervisor({ config: { ...config, statusOnly: true }, keys: [], exec: realExec,
    registry: [{ ...demo(), health: untrusted, busy: untrusted }] });
  cleanups.push(() => supervisor.actions.close());
  const [component] = (await supervisor.status()).components;
  expect(component).toMatchObject({ id: 'demo', state: 'down', busy: true, actions: [] });
  await expect(fs.access(marker)).rejects.toThrow();
  // Root-owned commands still run, and bare names resolve through the fixed system PATH.
  expect(await realExec.run(['/bin/true'])).toBe(0);
  expect(await realExec.run(['false'])).toBe(1);
});

it('action units leave a server the launcher backgrounds running after the launcher exits', async () => {
  const invocations: string[][] = [];
  const { actions } = await fixture({ async run(argv) { if (argv[0] === 'systemd-run') invocations.push([...argv]); return 0; } });
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo'); await until(() => !actions.running);
  expect(action.state).toBe('done');
  const [argv] = invocations;
  // The default KillMode=control-group kills everything left in the unit's cgroup once the
  // main process exits, which would stop a `nohup server &` the launcher just started.
  const options = argv!.slice(0, argv!.indexOf('--'));
  expect(options).toContain('--property=KillMode=process');
  expect(options.filter(option => option.startsWith('--property=KillMode='))).toHaveLength(1);
  expect(argv!.slice(argv!.indexOf('--') + 1)).toEqual(['demo', 'restart']);
});

it.each(['live-profile probe', 'ownership check'] as const)('a slow %s after the idle wait cannot launch past the idle deadline', async slow => {
  // Health answers come from a stubbed fetch: no port is bound or called.
  vi.stubGlobal('fetch', vi.fn(async () => { if (slow === 'live-profile probe') await delay(80); return new Response('{}', { status: 200 }); }));
  const registry = buildRegistry({ launchScript: '/home/me/demo/launch.sh' }).filter(entry => entry.id === 'main-model').map(entry => ({
    ...entry, profiles: entry.profiles!.map(profile => ({ ...profile, health: { kind: 'http' as const, url: 'http://127.0.0.1:8898/' + profile.id, timeoutMs: 500 } })) as Component['profiles'],
  }));
  const launched: string[][] = [];
  const { folder } = await fixture();
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), rescuePort: 8899, statusOnly: false, pollMs: 2, idleLimitMs: 20 });
  const trust = async (command: string) => { if (slow === 'ownership check') await delay(80); return command; };
  const actions = new Actions(registry, { async run(argv) { if (argv[0] === 'systemd-run') launched.push([...argv]); return 0; } }, config,
    async () => false, trust);
  cleanups.push(() => actions.close());
  const action = await actions.start({ verb: 'restart', target: 'main-model', when: 'idle' }, 'demo');
  await until(() => !actions.running);
  expect(action.state).toBe('failed'); expect(action.result).toContain('stayed busy too long'); expect(launched).toEqual([]);
  // Without a slow step, the same idle action launches.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const fast = new Actions(registry, { async run(argv) { if (argv[0] === 'systemd-run') launched.push([...argv]); return 0; } },
    { ...config, idleLimitMs: 5000 }, async () => false, trustAny);
  cleanups.push(() => fast.close());
  const ok = await fast.start({ verb: 'restart', target: 'main-model', when: 'idle' }, 'demo'); await until(() => !fast.running);
  expect(ok.state).toBe('done'); expect(launched).toHaveLength(1);
});

it('hides an optional component only when it is confirmed absent, never when the query fails', async () => {
  let answer: 'loaded' | 'not-found' | 'manager down' | 'throws' = 'loaded';
  const phone = buildRegistry({}, [{ id: 'phone', unit: { name: 'demo-phone.service', scope: 'user', user: 'demo' } }]).find(entry => entry.id === 'phone')!;
  const { config } = await fixture();
  const supervisor = createSupervisor({ config, registry: [{ ...phone, health: { kind: 'none' } }], keys: [],
    exec: { async run(argv, line) {
      if (argv.includes('show')) {
        if (answer === 'throws') throw new Error('obviously fake spawn failure');
        // An unavailable user manager: systemctl prints its error to stderr and exits 1.
        if (answer === 'manager down') { line?.('Failed to connect to bus: No such file or directory'); return 1; }
        line?.(answer); return 0;
      }
      return 1;
    } } });
  cleanups.push(() => supervisor.actions.close());
  const visible = async () => (await supervisor.status()).components.map(component => [component.id, component.state, component.actions.includes('start')]);
  expect(await visible()).toEqual([['phone', 'down', true]]);
  answer = 'manager down'; expect(await visible()).toEqual([['phone', 'down', true]]);
  answer = 'throws'; expect(await visible()).toEqual([['phone', 'down', true]]);
  answer = 'not-found'; expect(await visible()).toEqual([]);
  // The same three answers for a local HTTP installed probe (stubbed fetch, no port called).
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('obviously fake connection refused'); }));
  expect(await installation({ kind: 'http', url: 'http://127.0.0.1:8898/installed', timeoutMs: 50 }, { async run() { return 0; } })).toBe('unknown');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  expect(await installation({ kind: 'http', url: 'http://127.0.0.1:8898/installed', timeoutMs: 50 }, { async run() { return 0; } })).toBe('absent');
  expect(await installation({ kind: 'unit', command: ['demo'], expect: 'loaded' }, { async run() { return 0; } })).toBe('unknown');
});

it.each(['honours', 'ignores'] as const)('close() stops polling a launched action and releases its waiter when the runner %s the signal', async mode => {
  let launchedSignal: AbortSignal | undefined; const after: string[][] = [];
  let closed = false;
  const { actions, folder } = await fixture({ async run(argv, _line, options) {
    if (closed) after.push([...argv]);
    if (argv[0] !== 'systemd-run') return 0;
    launchedSignal = options?.signal;
    // The launcher keeps running for a long time; only the local wait may end.
    return new Promise<number>(resolve => { if (mode === 'honours') options?.signal?.addEventListener('abort', () => resolve(143), { once: true }); });
  } });
  const reads = vi.spyOn(OutputTail.prototype, 'read');
  const action = await actions.start({ verb: 'restart', target: 'demo' }, 'demo-caller');
  await until(() => launchedSignal !== undefined && reads.mock.calls.length > 2);
  const started = Date.now(); await actions.close(); closed = true;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(launchedSignal!.aborted).toBe(true);
  const polls = reads.mock.calls.length; await delay(60);
  expect(reads.mock.calls.length).toBe(polls); expect(after).toEqual([]);
  // The action unit is preserved: nothing is recorded, so the next start reconciles it.
  expect(action.state).toBe('running');
  expect(JSON.parse(await fs.readFile(join(folder, 'actions', action.id + '.json'), 'utf8'))).toMatchObject({ state: 'running' });
  await expect(fs.access(join(folder, 'audit.jsonl'))).rejects.toThrow();
});

it('the production runner ends a local wait on abort', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const exec = spawnExec(trustAny);
  const run = exec.run(['/bin/sleep', '30'], undefined, { signal: controller.signal });
  await delay(20); controller.abort();
  expect(await run).not.toBe(0); expect(Date.now() - started).toBeLessThan(5000);
  // An already aborted signal spawns nothing at all.
  await expect(exec.run(['/bin/sleep', '30'], undefined, { signal: AbortSignal.abort() })).rejects.toThrow();
});

it('reads only an explicit absence as not installed: other LoadStates and HTTP errors are unknown', async () => {
  let answer = 'loaded';
  const phone = buildRegistry({}, [{ id: 'phone', unit: { name: 'demo-phone.service', scope: 'user', user: 'demo' } }]).find(entry => entry.id === 'phone')!;
  expect(phone.installed).toMatchObject({ expect: 'loaded', absent: 'not-found' });
  const { config } = await fixture();
  const supervisor = createSupervisor({ config, registry: [{ ...phone, health: { kind: 'none' } }], keys: [],
    exec: { async run(argv, line) { if (argv.includes('show')) { line?.(answer); return 0; } return 1; } } });
  cleanups.push(() => supervisor.actions.close());
  const visible = async () => (await supervisor.status()).components.map(component => [component.id, component.state, component.actions.includes('start')]);
  // systemd reports these for a unit file that exists but is masked, unparsable or unloadable.
  for (answer of ['loaded', 'masked', 'error', 'bad-setting', 'merged', 'stub']) expect(await visible()).toEqual([['phone', 'down', true]]);
  answer = 'not-found'; expect(await visible()).toEqual([]);
  // An installation probe without the absence line never hides a component.
  const custom = { kind: 'unit' as const, command: ['demo'] as [string, ...string[]], expect: 'loaded' };
  expect(await installation(custom, { async run(_argv, line) { line?.('not-found'); return 0; } })).toBe('unknown');
  // HTTP: only an agreed 404 is absence; server errors and other refusals are unknown (stubbed fetch, no port called).
  const http = { kind: 'http' as const, url: 'http://127.0.0.1:8898/installed', timeoutMs: 50 };
  for (const [status, expected] of [[200, 'installed'], [404, 'absent'], [500, 'unknown'], [503, 'unknown'], [403, 'unknown'], [410, 'unknown']] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    expect([status, await installation(http, { async run() { return 0; } })]).toEqual([status, expected]);
  }
});

it.each(['idle deadline', 'shutdown'] as const)('the production runner refuses to spawn systemd-run once the %s passes during its own ownership check', async ending => {
  const { folder } = await fixture();
  // Stands in for systemd-run: it only leaves a marker, so the test can see whether anything spawned.
  const marker = join(folder, 'spawned'); const fake = join(folder, 'fake-systemd-run');
  await fs.writeFile(fake, '#!/bin/sh\ntouch ' + marker + '\n', { mode: 0o755 });
  let checks = 0;
  const slowTrust = async (command: string) => {
    if (command !== 'systemd-run') return '/bin/true';
    checks++; await delay(80); return fake;
  };
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), rescuePort: 8899, statusOnly: false, pollMs: 2, idleLimitMs: 20 });
  const actions = new Actions([demo()], spawnExec(slowTrust), config, async () => false, trustAny);
  cleanups.push(() => actions.close());
  const action = await actions.start({ verb: 'restart', target: 'demo', when: ending === 'idle deadline' ? 'idle' : 'now' }, 'demo');
  await until(() => checks === 1);
  if (ending === 'idle deadline') {
    await until(() => !actions.running);
    expect(action.state).toBe('failed'); expect(action.result).toContain('stayed busy too long');
  } else {
    // Shutdown records nothing for an action past its last await; the next start reconciles it.
    await actions.close(); await delay(120);
    const restarted = new Actions([demo()], spawnExec(slowTrust), config, async () => false, trustAny);
    cleanups.push(() => restarted.close());
    await restarted.initialize();
    expect((await restarted.get(action.id))?.state).toBe('failed');
  }
  await expect(fs.access(marker)).rejects.toThrow();
  // Without a deadline or shutdown, the same slow check still launches.
  const fast = new Actions([demo()], spawnExec(slowTrust), { ...config, idleLimitMs: 5000 }, async () => false, trustAny);
  cleanups.push(() => fast.close());
  const ok = await fast.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo'); await until(() => !fast.running);
  expect(ok.state).toBe('done'); await fs.access(marker);
});

it.each([['show', 'honours'], ['show', 'ignores'], ['list-units', 'honours'], ['list-units', 'ignores']] as const)(
  'close() ends a blocked %s query of a recovered action when the runner %s the signal', async (blocked, mode) => {
  const { config, folder } = await fixture();
  const id = 'obviously-fake-recovered';
  await fs.mkdir(join(folder, 'actions'), { recursive: true });
  await fs.writeFile(join(folder, 'actions', id + '.json'), JSON.stringify({ id, verb: 'restart', target: 'demo', when: 'now', caller: 'demo-caller', state: 'running', startedAt: 1 }));
  let listings = 0; let hung: AbortSignal | undefined; let closed = false; const after: string[][] = [];
  const hang = (signal?: AbortSignal) => {
    hung = signal;
    return new Promise<number>(resolve => { if (mode === 'honours') signal?.addEventListener('abort', () => resolve(143), { once: true }); });
  };
  const actions = new Actions([demo()], { async run(argv, line, options) {
    if (closed) after.push([...argv]);
    if (argv.includes('list-units')) {
      // The startup listing answers; with a blocked listing, the monitor's fallback one hangs.
      if (listings++ > 0 && blocked === 'list-units') return hang(options?.signal);
      line?.(`wayroost-act-${id}.service loaded active running Demo`); return 0;
    }
    if (argv.includes('show')) return blocked === 'show' ? hang(options?.signal) : show(line);
    return 0;
  } }, config, undefined, trustAny);
  cleanups.push(() => actions.close());
  await actions.initialize();
  expect(actions.running?.id).toBe(id);
  await until(() => hung !== undefined);
  const started = Date.now(); await actions.close(); closed = true;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(hung!.aborted).toBe(true);
  await delay(60); expect(after).toEqual([]);
  // The action stays running on disk, unaudited, for the next start to reconcile.
  expect(JSON.parse(await fs.readFile(join(folder, 'actions', id + '.json'), 'utf8'))).toMatchObject({ state: 'running' });
  await expect(fs.access(join(folder, 'audit.jsonl'))).rejects.toThrow();
});

it('close() ends a diagnostics action blocked on a systemctl query and records it as cancelled', async () => {
  let hung: AbortSignal | undefined;
  const { actions } = await fixture({ async run(argv, _line, options) {
    if (argv.includes('is-active')) { hung = options?.signal; return new Promise<number>(() => {}); }
    return 0;
  } });
  const unitDemo = buildRegistry({}).find(entry => entry.id === 'signalbox')!;
  const diagnosing = new Actions([unitDemo], actions.exec, actions.config, undefined, trustAny);
  cleanups.push(() => diagnosing.close());
  const action = await diagnosing.start({ verb: 'diagnostics', target: 'signalbox' }, 'demo');
  await until(() => hung !== undefined);
  const started = Date.now(); await diagnosing.close();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(hung!.aborted).toBe(true); expect(action.state).toBe('cancelled');
});

it.each(['shutdown', 'idle deadline'] as const)('the %s ends the busy probes of an idle wait, not just the wait', async ending => {
  const { folder } = await fixture();
  // Stands in for a hung busy probe: if it is not ended, it leaves a marker once it wakes.
  const marker = join(folder, 'probe-finished'); const script = join(folder, 'fake-busy-probe');
  await fs.writeFile(script, '#!/bin/sh\nsleep 0.3\ntouch ' + marker + '\n', { mode: 0o755 });
  let started = false;
  const trustProbe = async (command: string) => { if (command === 'demo-busy') started = true; return command === 'demo-busy' ? script : '/bin/true'; };
  const config = configSchema.parse({ development: true, stateDir: folder, socket: join(folder, 'socket'), rescuePort: 8899, statusOnly: false,
    pollMs: 2, idleLimitMs: ending === 'shutdown' ? 600000 : 40 });
  const actions = new Actions([{ ...demo(), busy: { kind: 'unit', command: ['demo-busy'] } }], spawnExec(trustProbe), config, undefined, trustAny);
  cleanups.push(() => actions.close());
  const action = await actions.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo');
  await until(() => started);
  if (ending === 'shutdown') {
    const closing = Date.now(); await actions.close();
    expect(Date.now() - closing).toBeLessThan(1000); expect(action.state).toBe('cancelled');
  } else {
    await until(() => !actions.running);
    expect(action.state).toBe('failed'); expect(action.result).toContain('stayed busy too long');
  }
  // The probe's command was sent SIGTERM when the wait ended: it never wakes to finish.
  await delay(450); await expect(fs.access(marker)).rejects.toThrow();
});

it('shutdown aborts the HTTP probes of an idle wait, a live-profile restart and a diagnostics action', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  }));
  const { config } = await fixture();
  // Long probe timeouts: only the shutdown can end these requests in time (stubbed fetch, no port called).
  const http = { kind: 'http' as const, url: 'http://127.0.0.1:8898/busy', timeoutMs: 600000 };
  const waiting = new Actions([{ ...demo(), busy: http }], { async run() { return 0; } }, { ...config, idleLimitMs: 600000 }, undefined, trustAny);
  cleanups.push(() => waiting.close());
  const idle = await waiting.start({ verb: 'restart', target: 'demo', when: 'idle' }, 'demo');
  await until(() => signals.length === 1);
  await waiting.close();
  expect(signals[0]!.aborted).toBe(true); expect(idle.state).toBe('cancelled');
  // A restart of the live profile probes it first; shutdown ends that probe and records a cancel.
  const model: Component = { ...demo(), restart: undefined, start: ['demo', 'start'],
    profiles: [{ id: 'first', name: 'First', gpus: [], health: http, argv: ['demo', 'first'] }, { id: 'second', name: 'Second', gpus: [], health: http, argv: ['demo', 'second'] }] };
  const ran: string[][] = [];
  const restarting = new Actions([model], { async run(argv) { ran.push([...argv]); return 0; } }, config, undefined, trustAny);
  cleanups.push(() => restarting.close());
  const restart = await restarting.start({ verb: 'restart', target: 'demo' }, 'demo');
  await until(() => signals.length === 2);
  const closing = Date.now(); await restarting.close();
  expect(Date.now() - closing).toBeLessThan(1000);
  expect(signals[1]!.aborted).toBe(true); expect(restart.state).toBe('cancelled');
  // The second profile is never probed and nothing launches.
  await delay(30); expect(signals).toHaveLength(2); expect(ran.filter(argv => argv[0] === 'systemd-run')).toEqual([]);
  // Diagnostics probes health the same way; shutdown ends that request too.
  const diagnosing = new Actions([{ ...demo(), health: http }], { async run() { return 0; } }, config, undefined, trustAny);
  cleanups.push(() => diagnosing.close());
  const diagnostics = await diagnosing.start({ verb: 'diagnostics', target: 'demo' }, 'demo');
  await until(() => signals.length === 3);
  await diagnosing.close();
  expect(signals[2]!.aborted).toBe(true); expect(diagnostics.state).toBe('cancelled');
});

it('the production runner spawns nothing once its signal is aborted, before or during the ownership check', async () => {
  const folder = await fs.mkdtemp(join(process.cwd(), '.supervisor-resilience-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  const marker = join(folder, 'spawned'); const script = join(folder, 'fake-command');
  await fs.writeFile(script, '#!/bin/sh\ntouch ' + marker + '\n', { mode: 0o755 });
  let checks = 0;
  const runner = spawnExec(async () => { checks++; await delay(40); return script; });
  await expect(runner.run(['demo'], undefined, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(checks).toBe(0);
  const controller = new AbortController();
  const run = runner.run(['demo'], undefined, { signal: controller.signal });
  await until(() => checks === 1); controller.abort();
  await expect(run).rejects.toThrow();
  await delay(30); await expect(fs.access(marker)).rejects.toThrow();
  // Without an abort the same runner spawns it.
  expect(await runner.run(['demo'])).toBe(0); await fs.access(marker);
});

/** Whether a process still exists (a test helper for the probe group cleanup). */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
it('an aborted command ends with its whole process group, SIGTERM-ignoring descendants included, and settles promptly', async () => {
  const folder = await fs.mkdtemp(join(process.cwd(), '.supervisor-resilience-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  // A shell probe that starts subprocesses: a plain one and one that ignores SIGTERM. Both keep its output open.
  const script = join(folder, 'fake-probe');
  await fs.writeFile(script, '#!/bin/sh\nsleep 30 &\necho $! > ' + join(folder, 'plain') + '\n(trap "" TERM; exec sleep 30) &\necho $! > '
    + join(folder, 'stubborn') + '\necho started\nwait\n', { mode: 0o755 });
  const runner = spawnExec(async () => script);
  const controller = new AbortController();
  let started = false;
  const run = runner.run(['demo'], line => { if (line === 'started') started = true; }, { signal: controller.signal });
  await until(() => started);
  const pids = await Promise.all(['plain', 'stubborn'].map(async name => Number(await fs.readFile(join(folder, name), 'utf8'))));
  cleanups.push(async () => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  expect(pids.every(alive)).toBe(true);
  const aborted = Date.now(); controller.abort();
  expect(await run).not.toBe(0);
  // Before: only the shell got SIGTERM and run() waited the full 30 s for the sleeps' pipes.
  // SIGKILL after the grace ends the stubborn one; the bound is generous for a loaded machine.
  expect(Date.now() - aborted).toBeLessThan(CLEANUP_LIMIT_MS + 8000);
  await until(() => !pids.some(alive));
}, 20000);

it('an aborted run() settles within its cleanup limit even if a descendant left the group, which is never signalled', async () => {
  const folder = await fs.mkdtemp(join(process.cwd(), '.supervisor-resilience-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  // Stands in for systemd-run: what runs in a unit is not the client's descendant, and is
  // modelled by a process in its own session. One holds the output, one finishes later.
  const marker = join(folder, 'unit-finished'); const ready = join(folder, 'unit-started'); const script = join(folder, 'fake-systemd-run');
  await fs.writeFile(script, '#!/bin/sh\nsetsid sleep 30 &\necho $! > ' + join(folder, 'escaped') + '\nsetsid sh -c "touch ' + ready + '; sleep 0.4; touch ' + marker
    + '" </dev/null >/dev/null 2>&1 &\necho started\nsleep 30\n', { mode: 0o755 });
  const runner = spawnExec(async () => script);
  const controller = new AbortController();
  let started = false;
  const run = runner.run(['systemd-run'], line => { if (line === 'started') started = true; }, { signal: controller.signal });
  await until(() => started);
  const escaped = Number(await fs.readFile(join(folder, 'escaped'), 'utf8'));
  cleanups.push(async () => { try { process.kill(escaped, 'SIGKILL'); } catch {} });
  // It must have entered its own session before the client's group is signalled.
  for (let count = 0; count < 300 && !(await fs.access(ready).then(() => true, () => false)); count++) await delay(10);
  await fs.access(ready);
  const aborted = Date.now(); controller.abort();
  expect(await run).not.toBe(0);
  // Generous for a loaded machine; without the limit it waits the full 30 s.
  expect(Date.now() - aborted).toBeLessThan(CLEANUP_LIMIT_MS + 8000);
  // The process outside the group is untouched: the "unit" still finishes its work.
  expect(alive(escaped)).toBe(true);
  for (let count = 0; count < 300 && !(await fs.access(marker).then(() => true, () => false)); count++) await delay(10);
  await fs.access(marker);
}, 20000);

/** A supervisor on the fixture's socket whose one component has a probe that hangs until its signal ends it. */
async function hangingStatus(hang: 'installed' | 'health' | 'busy' | 'profile') {
  const { config } = await fixture();
  const signals: AbortSignal[] = [];
  const wait = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signals.push(signal!); signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Stubbed fetch, no port called: a live-profile health probe is HTTP.
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => wait(init.signal!)));
  const unit = { kind: 'unit' as const, command: ['demo-hang'] as [string, ...string[]] };
  const entry: Component = { ...demo(),
    ...(hang === 'installed' ? { optional: true, installed: { ...unit, expect: 'loaded', absent: 'not-found' } } : {}),
    ...(hang === 'health' ? { health: unit } : {}), ...(hang === 'busy' ? { busy: unit } : {}),
    ...(hang === 'profile' ? { restart: undefined, profiles: [{ id: 'first', name: 'First', gpus: [], argv: ['demo', 'first'],
      health: { kind: 'http' as const, url: 'http://127.0.0.1:8898/health', timeoutMs: 600000 } }] } : {}) };
  const exec: Exec = { async run(argv, _line, options) {
    if (argv[0] !== 'demo-hang') return 0;
    // A runner that honours the signal, as spawnExec does.
    return new Promise<number>(resolve => { signals.push(options!.signal!); options?.signal?.addEventListener('abort', () => resolve(143), { once: true }); });
  } };
  const supervisor = createSupervisor({ config, registry: [entry], keys: [{ name: 'demo-server', scope: 'server', sha256: hashKey('fake-server-key') }],
    exec, actions: new Actions([entry], exec, config, undefined, trustAny) });
  await supervisor.start();
  let closed = false;
  cleanups.push(async () => { if (!closed) await supervisor.close(); });
  return { config, supervisor, signals, close: async () => { closed = true; await supervisor.close(); } };
}

it.each(['installed', 'health', 'busy', 'profile'] as const)('shutdown ends a GET /v1/status blocked on its %s probe and close() returns', async hang => {
  const { config, signals, close } = await hangingStatus(hang);
  const answer = new Promise<number | string>(resolve => {
    const req = request({ socketPath: config.socket, path: '/v1/status', headers: { authorization: 'Bearer fake-server-key' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', error => resolve(error.message)); req.end();
  });
  await until(() => signals.length === 1);
  // Before: no signal reached the probe, so the response stayed open and close() waited for it.
  const closing = Date.now(); await close();
  expect(Date.now() - closing).toBeLessThan(1000);
  expect(signals[0]!.aborted).toBe(true);
  expect(await answer).toBe(503);
  // Nothing probed after the shutdown.
  await delay(30); expect(signals).toHaveLength(1);
});

it('an event client that leaves ends its status probes, and shutdown ends the poll for the others', async () => {
  const { config, signals, close } = await hangingStatus('health');
  const connect = () => {
    const req = request({ socketPath: config.socket, path: '/v1/events', headers: { authorization: 'Bearer fake-server-key' } }, res => { res.resume(); });
    req.on('error', () => {}); req.end();
    return req;
  };
  const leaving = connect();
  await until(() => signals.length > 0);
  leaving.destroy();
  // The client is gone: its initial status collection, and the poll that ran for it, stop
  // probing without any shutdown.
  await until(() => signals.every(signal => signal.aborted));
  const before = signals.length;
  connect();
  await until(() => signals.length > before);
  const closing = Date.now(); await close();
  expect(Date.now() - closing).toBeLessThan(1000);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it('an aborted command still kills a SIGTERM-ignoring descendant after the parent closes its output', async () => {
  const folder = await fs.mkdtemp(join(process.cwd(), '.supervisor-resilience-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  const script = join(folder, 'fake-probe');
  // The descendant redirects both pipes, so the parent's close does not wait for it.
  await fs.writeFile(script, '#!/bin/sh\nsh -c \'trap "" TERM; echo ready; exec sleep 30\' </dev/null > '
    + join(folder, 'ready') + ' 2>&1 &\necho $! > ' + join(folder, 'stubborn')
    + '\nwhile [ ! -s ' + join(folder, 'ready') + ' ]; do sleep 0.01; done\necho started\nwait\n', { mode: 0o755 });
  const controller = new AbortController();
  let started = false;
  const run = spawnExec(async () => script).run(['demo'], line => { if (line === 'started') started = true; }, { signal: controller.signal });
  cleanups.push(async () => { controller.abort(); await run; });
  await until(() => started);
  const stubborn = Number(await fs.readFile(join(folder, 'stubborn'), 'utf8'));
  cleanups.push(async () => { try { process.kill(stubborn, 'SIGKILL'); } catch {} });
  expect(alive(stubborn)).toBe(true);
  controller.abort();
  expect(await run).not.toBe(0);
  await delay(KILL_GRACE_MS + 100);
  // Before: close cleared the escalation timer, and this descendant slept for 30 s.
  await until(() => !alive(stubborn));
}, 20000);

it.each([
  ['/v1/actions', 'server', false], ['/v1/actions', 'rescue', false], ['/v1/busy', 'server', true],
] as const)('shutdown ends an incomplete %s upload on the %s listener (status-only: %s)', async (path, listener, statusOnly) => {
  const { config } = await fixture();
  const exec: Exec = { run: vi.fn(async () => 0) };
  const supervisor = createSupervisor({ config: { ...config, statusOnly }, registry: [demo()], exec, trust: trustAny,
    keys: [{ name: 'demo-' + listener, scope: listener, sha256: hashKey('fake-' + listener + '-key') }] });
  await supervisor.start();
  vi.mocked(exec.run).mockClear();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finishActions = supervisor.actions.close.bind(supervisor.actions);
  vi.spyOn(supervisor.actions, 'close').mockImplementation(async () => { await finishActions(); await gate; });
  let received = false;
  supervisor[listener === 'server' ? 'socket' : 'rescue'].once('request', () => { received = true; });
  let req!: ReturnType<typeof request>;
  const answer = new Promise<number | string>(resolve => {
    req = request({ ...(listener === 'server' ? { socketPath: config.socket } : { host: '127.0.0.1', port: config.rescuePort }),
      path, method: 'POST', headers: { authorization: 'Bearer fake-' + listener + '-key', 'content-length': '512' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', error => resolve(error.message));
    req.write('{');
  });
  let closing: Promise<void> | undefined;
  cleanups.push(async () => { req.destroy(); release(); await (closing ?? supervisor.close()); });
  await until(() => received);
  expect(req.writableEnded).toBe(false);
  closing = supervisor.close();
  // Body cancellation precedes action cleanup and the listeners' closeAllConnections().
  expect(await Promise.race([answer, delay(1000).then(() => 'timeout')])).toBe('socket hang up');
  release();
  expect(await Promise.race([closing.then(() => true), delay(1000).then(() => false)])).toBe(true);
  expect(supervisor.actions.records.size).toBe(0);
  expect(supervisor.actions.busy.state()).toBe('unknown');
  expect(exec.run).not.toHaveBeenCalled();
});

it.each(['server', 'rescue'] as const)('shutdown closes a connection stalled in its HTTP headers on the %s listener', async listener => {
  const { config } = await fixture();
  const supervisor = createSupervisor({ config, registry: [demo()], keys: [], exec: { async run() { return 0; } }, trust: trustAny });
  await supervisor.start();
  let received = false;
  supervisor[listener === 'server' ? 'socket' : 'rescue'].once('connection', () => { received = true; });
  const client = listener === 'server' ? connect(config.socket) : connect(config.rescuePort, '127.0.0.1');
  client.on('error', () => {});
  const left = new Promise<void>(resolve => client.once('close', () => resolve()));
  client.write('POST /v1/busy HTTP/1.1\r\n');
  let closing: Promise<void> | undefined;
  cleanups.push(async () => { client.destroy(); await (closing ?? supervisor.close()); });
  await until(() => received);
  closing = supervisor.close();
  expect(await Promise.race([closing.then(() => true), delay(1000).then(() => false)])).toBe(true);
  await left;
});
