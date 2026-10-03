import { BackgroundGate } from '../server/src/background.js';
// Try Signalbox without Hermes, Paseo or Cloudflare: runs the real server with
// demo data behind a local stand-in for Cloudflare Access.
//   npm run build:web && npm run demo     then open http://127.0.0.1:8890
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../server/src/app.js';
import { WorkerUpdatesSetting } from '../server/src/tasks/setting.js';
import { demoTasks } from './demo-tasks.js';
import { parseConfig } from '../server/src/config.js';
import { EventHub } from '../server/src/hub.js';
import { createAccessVerifier } from '../server/src/security/access.js';
import { Devices } from '../server/src/devices.js';
import { PAIR_PATH } from '../shared/protocol.js';
import { demoAssist, demoConnectors, demoDashboard, demoHelper, demoPaseoSchedules } from './demo-connectors.js';
import { Schedules } from '../server/src/schedules.js';
import { SafetyCommandsSetting } from '../server/src/hermes/safety.js';
import { DemoHermes, DemoPaseo, startDemoBridge } from './demo-sources.js';
import { DemoSupervisor } from './demo-power.js';
import { DemoWorkerApprovals } from './demo-safety.js';
import { demoFeed } from './demo-feed.js';
import { createLocalAccess, startEdge } from './lib/local-access.js';

const PORT = Number(process.env.PORT ?? 8890);
const APP_PORT = PORT + 1;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const access = await createLocalAccess({ issuer: 'http://127.0.0.1:1' });
const config = parseConfig(
  {
    listen: { host: '127.0.0.1', port: APP_PORT },
    publicOrigin: ORIGIN,
    access: { teamDomain: access.issuer, aud: access.aud, allowedEmails: [access.email] },
    stateDir: mkdtempSync(join(tmpdir(), 'sb-demo-')),
    staticDir: resolve('dist/web'),
  },
  { allowLocalDev: true },
);
const hub = new EventHub();
const sources = { hermes: new DemoHermes(hub), paseo: new DemoPaseo(hub) };
const bridge = await startDemoBridge(sources, hub);
const feed = demoFeed(hub, sources.hermes, config.stateDir);
feed.start();
// Sign in by pairing, as on a real install: the link below pairs this browser.
const devices = new Devices(config.stateDir);
// A pretend supervisor behind the real power routes: the status block and Status &
// power show this machine's shape without touching any real service.
const supervisor = new DemoSupervisor();
const app = await buildApp({
  config,
  devices,
  supervisor,
  verifier: createAccessVerifier({ ...config.access!, keySource: access.keySource }),
  hub,
  sources,
  bridge,
  connectors: demoConnectors(ORIGIN),
  schedules: new Schedules({ background: new BackgroundGate('primary'),
    dashboard: () => demoDashboard,
    triggerRoles: () => demoHelper.triggerRoles(),
    paseo: demoPaseoSchedules,
    assist: demoAssist,
    onChanged: () => hub.publish({ type: 'schedules_changed' }),
    log: { info() {}, warn() {} },
  }),
  whatsappRouting: demoHelper,
  phone: demoHelper,
  feed,
  // Settings → Security reads this on every Settings screen; off, as on a fresh install.
  safetyCommands: new SafetyCommandsSetting(config.stateDir),
  workerApprovals: new DemoWorkerApprovals(),
  // Settings → Project bridge → Worker updates; the demo runs no task log, only its settings row.
  workerUpdates: new WorkerUpdatesSetting(config.stateDir),
  tasks: demoTasks,
  logger: false,
});
app.addHook('onClose', async () => supervisor.stop());
await app.listen({ host: '127.0.0.1', port: APP_PORT });
await startEdge({ port: PORT, appPort: APP_PORT, token: access.token });
console.log(`Wayroost demo: ${ORIGIN}  (demo data; Ctrl+C to stop)`);
console.log(`Pair this browser (single use, 10 minutes): ${ORIGIN}${PAIR_PATH}#${devices.createCode('desktop').code}`);
