import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { BRIDGE_HOST, buildBridgeServer } from './bridge/server.js';
import { Bridge } from './bridge/service.js';
import { readOrCreateBridgeToken } from './bridge/token.js';
import { configPath, loadStartupConfig } from './config.js';
import { BackgroundGate } from './background.js';
import { wayroostEnv } from './environment.js';
import { lockStateDirectory } from './state-directory.js';
import { HelperClient, readHelperToken } from './connectors/helper.js';
import { Connectors } from './connectors/service.js';
import { Assist } from './assist.js';
import { Schedules } from './schedules.js';
import { Skills } from './skills.js';
import { DisabledHermes, DisabledPaseo } from './disabled.js';
import { HermesAdapter, type Logger } from './hermes/adapter.js';
import { EventHub } from './hub.js';
import { Lineage } from './lineage.js';
import { PaseoAdapter } from './paseo/adapter.js';
import { SafetyHelperClient } from './paseo/safety-rpc.js';
import { SecretStore, readOrCreateClientId } from './secrets.js';
import { SpeechClient } from './speech.js';
import { CloudSpeechClient } from './cloud-speech.js';
import { PushSender } from './feed/push.js';
import { createNotificationServices } from './notifications/service.js';
import { SafetyCommandsSetting } from './hermes/safety.js';
import { SupervisorClient } from './supervisor-client.js';
import { BusyReporter, countBusy, phoneSource } from './busy.js';
import { createAccessVerifier, remoteAccessKeys } from './security/access.js';
import { Devices } from './devices.js';
import { startPairingSocket } from './pairing-socket.js';
import { WorkerUpdatesSetting } from './tasks/setting.js';
import type { TaskRelay } from './tasks/relay.js';
import { createTaskRelay } from './tasks/wire.js';
import { localSettingsListener } from './settings/listener.js';
import { buildChecks } from './checks/sources.js';

// Structured logs to stdout (journald). Never log tokens, cookies or message text.
// LOG_LEVEL uses the request logger's names: trace, debug, info, warn, error, fatal, silent.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const logLevel = wayroostEnv('LOG_LEVEL') ?? process.env.LOG_LEVEL ?? 'info';
const logs = (level: string) => logLevel !== 'silent' && LEVELS.indexOf(level) >= Math.max(0, LEVELS.indexOf(logLevel));
const log: Logger = {
  info: (obj, msg) => {
    if (logs('info')) console.log(JSON.stringify({ level: 'info', name: 'Wayroost', msg, ...obj }));
  },
  warn: (obj, msg) => {
    if (logs('warn')) console.warn(JSON.stringify({ level: 'warn', name: 'Wayroost', msg, ...obj }));
  },
  error: (obj, msg) => {
    if (logs('error')) console.error(JSON.stringify({ level: 'error', name: 'Wayroost', msg, ...obj }));
  },
};

const path = configPath();
let loaded;
let stateLock: Awaited<ReturnType<typeof lockStateDirectory>>;
try {
  loaded = loadStartupConfig(path);
  // Before any store opens: a shadow and a primary never share a state directory.
  stateLock = await lockStateDirectory(loaded.stateDir, loaded.role);
  loaded.stateDir = stateLock.path;
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const config = {
  ...loaded,
  staticDir: loaded.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), '../web'),
};

// Paired devices (the sign-in), and the recovery socket root uses to get a pairing code.
let devices: Devices | undefined;
try {
  devices = config.devices.enabled ? new Devices(config.stateDir) : undefined;
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const background = new BackgroundGate(config.role);
const hub = new EventHub();
// Who started what, for runs agents start from a shell: kept in the state directory.
const lineage = new Lineage(config.stateDir, log, Date.now, background);
// Settings → Security → "Hermes safety commands" (off unless switched on).
const safetyCommands = config.hermes.enabled ? new SafetyCommandsSetting(config.stateDir) : undefined;
const hermes = config.hermes.enabled
  ? new HermesAdapter(config.hermes.url, hub, new SecretStore(config.stateDir), log, {
      background,
      stateDir: config.stateDir,
      secretPrompts: config.hermes.secretPrompts,
      lineage,
      allowSafetyCommands: () => safetyCommands?.enabled() ?? false,
    })
  : new DisabledHermes();
const paseo = config.paseo.enabled
  ? new PaseoAdapter(config.paseo.url, hub, log, readOrCreateClientId(config.stateDir, background), undefined, background)
  : new DisabledPaseo();
if (paseo instanceof PaseoAdapter) paseo.useLineage(lineage);
let workerApprovals: SafetyHelperClient | undefined;
if (config.paseo.enabled && config.safetyHelper && process.env.CREDENTIALS_DIRECTORY) {
  try {
    const key = readFileSync(join(process.env.CREDENTIALS_DIRECTORY, 'safety-helper-key'), 'utf8').trim();
    if (!key) throw new Error('missing credential');
    workerApprovals = new SafetyHelperClient(config.safetyHelper.socket, key);
  } catch {
    log.error({}, 'the Safety helper credential is unavailable; policy application is pending');
  }
}
if (paseo instanceof PaseoAdapter) paseo.useConfigWriter(workerApprovals);
hub.onWatchChange((source, id, watching) => (source === 'hermes' ? hermes : paseo).setWatching(id, watching));

let helper: HelperClient | undefined;
if (config.helper.enabled) {
  const token = readHelperToken();
  if (token) helper = new HelperClient(config.helper.port, token, config.role);
  else log.error({}, 'the helper is enabled but its secret is missing (run deploy/setup-helper.sh); Google and triggers are off');
}

// Settings → Scheduled jobs: Hermes' cron jobs, through its dashboard.
const schedules =
  hermes instanceof HermesAdapter || paseo instanceof PaseoAdapter
    ? new Schedules({
        background,
        ...(helper ? { triggerRoles: () => helper.triggerRoles() } : {}),
        dashboard: () => (hermes instanceof HermesAdapter ? hermes.dashboard() : undefined),
        ...(paseo instanceof PaseoAdapter ? { paseo } : {}),
        assist: new Assist(),
        stateDir: config.stateDir,
        onChanged: () => hub.publish({ type: 'schedules_changed' }),
        log,
      })
    : undefined;

// For you: cards from Hermes' pulse and phone notifications (https only).
const push = config.publicOrigin.startsWith('https://')
  ? new PushSender(config.stateDir, config.publicOrigin, log, undefined, background)
  : undefined;
// Settings → Notifications: where each alert goes. The rules, the quiet hours and the
// phone's switches are Wayroost's own settings, written through the write-through core.
const { notifications, feed } = await createNotificationServices({
  background,
  stateDir: config.stateDir,
  feedEnabled: config.feed.enabled,
  hermes,
  hub,
  ...(schedules ? { schedules } : {}),
  ...(push ? { push } : {}),
  log,
  ...(config.notifications.timeZone ? { timeZone: config.notifications.timeZone } : {}),
});

// The project bridge, when turned on: its own listener on 127.0.0.1 only, with a
// bearer token. If it can't start, Signalbox runs without it.
let bridge: Bridge | undefined;
let bridgeServer: FastifyInstance | undefined;
await background.run(async () => {
  if (config.bridge.enabled) {
    const candidate = new Bridge({ sources: { hermes, paseo }, hub, log, port: config.bridge.port, lineage, background });
    let server: FastifyInstance | undefined;
    try {
      const token = readOrCreateBridgeToken(config.stateDir, background);
      server = await buildBridgeServer({ bridge: candidate, token, port: config.bridge.port, log, background, ...(feed ? { feed } : {}) });
      await server.listen({ host: BRIDGE_HOST, port: config.bridge.port });
      bridge = candidate;
      bridgeServer = server;
    } catch (err) {
      await server?.close().catch(() => {});
      log.error({ err: (err as Error).message }, 'the project bridge could not start; running without it');
    }
  }
});

// Worker updates: the task log tells a Hermes chat when a Paseo worker it started
// stops, waits on you or runs late (Settings → Project bridge). Needs the bridge,
// which only a primary runs: in shadow there is no completion relay at all.
const workerUpdates = bridge ? new WorkerUpdatesSetting(config.stateDir) : undefined;
let taskRelay: TaskRelay | undefined;
if (bridge && workerUpdates && hermes instanceof HermesAdapter && paseo instanceof PaseoAdapter) {
  taskRelay = createTaskRelay({
    hermes,
    paseo,
    bridge,
    hub,
    ...(feed ? { feed } : {}),
    setting: workerUpdates,
    stateDir: config.stateDir,
    log,
    background,
  });
}

// Settings → Connectors: Hermes' dashboard does the work; the helper (when
// set up) does Google's sign-in and the trigger folders as the Hermes user.
const connectors =
  hermes instanceof HermesAdapter
    ? new Connectors({
        background,
        dashboard: () => hermes.dashboard(),
        dashboardUrl: config.hermes.url,
        publicOrigin: config.publicOrigin,
        ...(helper ? { helper } : {}),
        reloadTools: () => hermes.reloadTools(),
        log,
      })
    : undefined;

// Settings → Skills: the helper reads and syncs the skill folders; Hermes' hub is the marketplace.
const skills = helper
  ? new Skills({
      background,
      helper,
      dashboard: () => (hermes instanceof HermesAdapter ? hermes.dashboard() : undefined),
      changed: () => hub.publish({ type: 'skills_changed' }),
      log,
    })
  : undefined;

// Voice mode, when deploy/setup-speech.sh turned it on: the speech service's socket.
const speech = config.speech.enabled ? new SpeechClient(config.speech.socket) : undefined;

// Status & power: the supervisor on its Unix socket, when this install has one.
// Its key is read from the key file once, here, and never written to a log.
const supervisor = config.supervisor
  ? new SupervisorClient(config.supervisor.socket, config.supervisor.keyFile, log)
  : undefined;
// What "restart when idle" waits on: running turns and calls, as counts only.
const phoneLine = phoneSource(helper, config.helper.enabled);
const busy = supervisor
  ? new BusyReporter(supervisor, () => countBusy({ hermes, paseo, ...(phoneLine ? { phone: phoneLine } : {}) }), log)
  : undefined;

// Settings → Checks: one snapshot of the configured sources.
const checks = buildChecks(config, supervisor);

const accessKeys = config.access
  ? remoteAccessKeys(config.access.jwksUrl, (err) =>
      log.warn({ err: String(err) }, 'could not refresh Cloudflare Access signing keys'),
    )
  : undefined;
const app = await buildApp({
  config,
  ...(config.access && accessKeys ? { verifier: createAccessVerifier({ ...config.access, keySource: accessKeys.keySource }) } : {}),
  ...(devices ? { devices } : {}),
  hub,
  sources: { hermes, paseo },
  logger: { level: logLevel, name: 'Wayroost' },
  ...(bridge ? { bridge } : {}),
  ...(connectors ? { connectors } : {}),
  ...(schedules ? { schedules } : {}),
  ...(safetyCommands ? { safetyCommands } : {}),
  ...(workerApprovals ? { workerApprovals } : {}),
  ...(speech ? { speech } : {}),
  ...(speech ? { cloudSpeech: new CloudSpeechClient(config.speech.cloudSocket) } : {}),
  ...(feed ? { feed } : {}),
  notifications,
  // Settings → WhatsApp: the whatsapp-routing Hermes plugin's settings, through the helper.
  ...(connectors && helper ? { whatsappRouting: helper } : {}),
  // Settings → Phone: Hermes Phone's status and PIN, through the helper.
  ...(helper ? { phone: helper } : {}),
  // Settings → Skills, through the helper.
  ...(skills ? { skills } : {}),
  // Status & power, through the supervisor.
  ...(supervisor ? { supervisor } : {}),
  // Settings → Checks: the engine, with the sources this PC has.
  settings: { ...(checks ? { checks } : {}) },
  // Settings → Project bridge → Worker updates.
  ...(taskRelay && workerUpdates ? { workerUpdates, tasks: taskRelay } : {}),
});

const localListener = config.localListener ? localSettingsListener(app, config) : undefined;
await app.listen({ host: config.listen.host, port: config.listen.port });
if (localListener && config.localListener) {
  await new Promise<void>((resolve, reject) => {
    localListener.once('error', reject);
    localListener.listen(config.localListener!.port, config.localListener!.host, () => { localListener.removeListener('error', reject); resolve(); });
  });
}
// Only root and the service user can reach it (see pairing-socket.ts). Without it
// the app still runs; recovery waits for the next start.
const pairingSocket = devices
  ? await startPairingSocket({
      devices,
      stateDir: config.stateDir,
      // Links for browsers only: on a local origin just the desktop app pairs, and it takes the bare code.
      origins: config.origins.filter((o) => !o.local).map((o) => o.origin),
      log,
    }).catch((err: Error) => {
      log.error({ err: err.message }, 'the pairing recovery socket could not start');
      return undefined;
    })
  : undefined;
// Before Paseo starts, so the task log sees the first list of workers. Its timer,
// chat posts, overdue cards and saves also sit behind the shared gate.
taskRelay?.start();
hermes.start();
paseo.start();
feed?.start();
skills?.start();
// Pushing busy counts is unattended work: the primary's alone.
background.run(() => busy?.start());
log.info(
  {
    role: config.role,
    roleSource: wayroostEnv('ROLE') === 'shadow' ? 'environment' : 'config (shadow wins)',
    origin: config.publicOrigin,
    origins: config.origins.length,
    signIn: [...(devices ? ['devices'] : []), ...(config.access ? ['access'] : [])].join('+'),
    listen: `${config.listen.host}:${config.listen.port}`,
    ...(bridge ? { bridge: `${BRIDGE_HOST}:${config.bridge.port}` } : {}),
    ...(config.hermes.enabled && config.hermes.secretPrompts ? { hermesSecretPrompts: true } : {}),
    ...(speech ? { voice: true } : {}),
    ...(feed ? { forYou: true } : {}),
    ...(config.supervisor ? { power: true } : {}),
    ...(taskRelay ? { workerUpdates: workerUpdates!.enabled() } : {}),
  },
  'Wayroost started',
);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Wayroost shutting down');
  // First, while the sources still answer: no counts from a server half torn down.
  busy?.stop();
  taskRelay?.stop(); // saves the task log: undelivered updates go out after the restart
  bridge?.stop();
  feed?.stop();
  await bridgeServer?.close().catch(() => {});
  hermes.stop();
  paseo.stop();
  skills?.stop();
  accessKeys?.stop();
  pairingSocket?.close();
  await app.close().catch(() => {});
  lineage.save(); // a report from the last half second isn't lost
  await stateLock.release();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
