import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedExec, trustAny } from './fixtures.js';
import { Actions, BusyError, StatusOnlyError } from '../src/actions.js';
import { configSchema } from '../src/config.js';
import { BUILTIN_COMPONENTS, buildRegistry } from '../src/registry.js';
import { authenticate, hashKey, permits } from '../src/keys.js';
const ADOPT = { launchScript: '/demo/bin/launch.sh', coderScript: '/demo/bin/launch-vllm.sh', holdDir: '/demo/state' };
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
it('status-only refuses every verb before execution, queuing, hold files or audit writes', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-')); folders.push(folder);
  const calls: string[][] = [];
  const config = configSchema.parse({ development: true, stateDir: folder, statusOnly: true, adopt: ADOPT });
  const actions = new Actions(buildRegistry(ADOPT), { async run(argv) { calls.push([...argv]); return 0; } }, config);
  for (const verb of ['start', 'stop', 'restart', 'hold', 'release', 'switch-model', 'diagnostics'] as const) {
    for (const when of ['now', 'idle'] as const) {
      const request = { verb, target: verb === 'switch-model' ? 'main-model' : 'coder', when,
        ...(verb === 'switch-model' ? { profile: 'balanced' } : {}) };
      expect(() => actions.validate(request)).toThrow(StatusOnlyError);
      expect(() => actions.start(request, 'demo-server')).toThrow('status-only');
    }
  }
  expect(calls).toEqual([]); expect(actions.records.size).toBe(0); expect(actions.running).toBeUndefined();
  expect(await readdir(folder)).toEqual([]);
  expect(configSchema.parse({ development: true,}).statusOnly).toBe(true);
  expect(() => configSchema.parse({ development: true, statusOnly: 'true' })).toThrow();
});
it('rejects unsupported fields and chooses the registry argv under a single action lock', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-')); folders.push(folder);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const actions = new Actions(buildRegistry(ADOPT), isolatedExec({ async run(argv, line) { calls.push([...argv]); line?.('fake output'); await gate; return 0; } }),
    configSchema.parse({ development: true, stateDir: folder, adopt: ADOPT, statusOnly: false }), undefined, trustAny);
  for (const request of [
    { verb: 'bad', target: 'coder' }, { verb: 'restart', target: 'bad' },
    { verb: 'switch-model', target: 'main-model', profile: 'bad' },
    { verb: 'restart', target: 'coder', argv: ['injected'] },
  ]) expect(() => actions.validate(request)).toThrow();
  const action = await actions.start({ verb: 'switch-model', target: 'main-model', profile: 'balanced' }, 'demo');
  expect(() => actions.start({ verb: 'restart', target: 'coder' }, 'demo')).toThrow(BusyError);
  for (let count = 0; !calls.length && count < 100; count++) await delay(2);
  expect(calls).toEqual([['systemd-run', '--unit=wayroost-act-' + action.id, '--property=CollectMode=inactive', '--property=KillMode=process', '--wait', '--quiet', '--property=StandardOutput=append:' + join(folder, 'actions', action.id + '.log'), '--property=StandardError=append:' + join(folder, 'actions', action.id + '.log'), '--', '/demo/bin/launch.sh', 'balanced']]);
  release();
  for (let count = 0; actions.running && count < 100; count++) await delay(2);
  expect(action.state).toBe('done');
  expect(await readFile(join(folder, 'audit.jsonl'), 'utf8')).not.toContain('fake output');
});
it('asks components to be set up before taking actions on them', async () => {
  const folder = await mkdtemp(join(process.cwd(), '.supervisor-test-')); folders.push(folder);
  // No adopt section: the launcher-backed components have no argv to run.
  const actions = new Actions(buildRegistry(), { async run() { return 0; } }, configSchema.parse({ development: true, stateDir: folder, statusOnly: false }));
  for (const request of [
    { verb: 'restart', target: 'main-model' }, { verb: 'switch-model', target: 'main-model', profile: 'balanced' },
    { verb: 'start', target: 'coder' }, { verb: 'stop', target: 'paseo' },
  ]) expect(() => actions.validate(request)).toThrow('Not set up on this PC.');
  expect(() => actions.validate({ verb: 'restart', target: 'signalbox' })).not.toThrow();
});
it('authenticates hashes and permits only the declared rescue action', () => {
  const server = { name: 'demo-server', scope: 'server' as const, sha256: hashKey('fake-server') };
  const rescue = { name: 'demo-rescue', scope: 'rescue' as const, sha256: hashKey('fake-rescue') };
  expect(authenticate('unknown', [server, rescue])).toBeUndefined();
  expect(authenticate('fake-server', [server, rescue])).toEqual(server);
  expect(permits(rescue, { verb: 'restart', target: 'wayroost-server' })).toBe(true);
  for (const verb of ['start', 'stop', 'hold', 'release', 'switch-model', 'diagnostics'] as const) {
    expect(permits(rescue, { verb, target: 'wayroost-server' })).toBe(false);
    expect(permits(server, { verb, target: 'wayroost-server' })).toBe(true);
  }
  expect(permits(rescue, { verb: 'restart', target: 'coder' })).toBe(false);
});
// The built-in list is also the public face of the product: keep it generic.
it('built-in registry names match the contract', () => {
  expect(BUILTIN_COMPONENTS.map(entry => entry.id).sort()).toEqual([
    'coder', 'helper', 'hermes-dashboard', 'hermes-gateway', 'keepalive', 'main-model',
    'paseo', 'phone', 'signalbox', 'signalbox-tunnel', 'speech', 'wayroost-server',
  ].sort());
});
