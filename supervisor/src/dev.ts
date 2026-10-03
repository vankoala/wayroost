// The development supervisor every other package builds against: fake runner,
// fake registry whose state flips on a timer, dev keys, rescue on 127.0.0.1:8898.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema } from './config.js';
import { buildRegistry } from './registry.js';
import { hashKey } from './keys.js';
import { createSupervisor } from './server.js';
import type { SupervisorStatus } from '../../shared/supervisor.js';
import { summary } from './actions.js';

const folder = await mkdtemp(join(process.cwd(), '.supervisor-dev-'));
const serverKey = randomBytes(32).toString('hex');
const rescueKey = randomBytes(32).toString('hex');
// Demo adopt paths so every component is set up; the fake runner never executes them.
const registry = buildRegistry({ launchScript: '/demo/bin/launch.sh', coderScript: '/demo/bin/launch-vllm.sh', holdDir: folder });
let up = true;
const supervisor = createSupervisor({
  config: configSchema.parse({ development: true, socket: join(folder, 'supervisor.sock'), rescuePort: 8898, stateDir: folder, statusOnly: false }),
  registry,
  keys: [{ name: 'demo-server', scope: 'server', sha256: hashKey(serverKey) }, { name: 'demo-rescue', scope: 'rescue', sha256: hashKey(rescueKey) }],
  // The fake runner never executes anything, so the demo paths need no ownership check.
  trust: async command => command,
  exec: { async run(argv, line) { if (argv.includes('list-units')) return 0; line?.('Starting the demo component.'); await delay(300); line?.('The demo component is ready.'); return 0; } },
  status: async (): Promise<SupervisorStatus> => ({
    overall: up ? 'ok' : 'attention', sentence: up ? 'Everything is running.' : 'The demo model is starting.', at: Date.now(),
    busy: supervisor.actions.busy.state(),
    ...(supervisor.actions.running ? { running: summary(supervisor.actions.running) } : {}),
    components: registry.map(entry => ({ id: entry.id, name: entry.name, state: up ? 'up' : 'starting', sentence: entry.name + (up ? ' is running.' : ' is starting.'), since: Date.now(),
      busy: supervisor.actions.busy.componentBusy(entry.id), actions: ['restart'],
      ...(entry.profiles ? { model: { live: 'main-model', profiles: entry.profiles.map(({ argv: _argv, health: _health, ...profile }) => profile) } } : {}) })),
  }),
});
try { await supervisor.start(); }
catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
// The real server pushes counts every ~10 s; the dev one just says "idle" so when:"idle" runs.
supervisor.actions.busy.record({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
const timer = setInterval(() => {
  up = !up;
  supervisor.actions.busy.record({ paseoRunning: 0, hermesRunning: 0, calls: 0 });
}, 5000);
console.log('Socket: ' + join(folder, 'supervisor.sock'));
console.log('Rescue: http://127.0.0.1:8898');
console.log('Server key: ' + serverKey);
console.log('Rescue key: ' + rescueKey);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(timer);
  void supervisor.close().then(() => rm(folder, { recursive: true, force: true }));
});
