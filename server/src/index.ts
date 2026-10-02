import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { BRIDGE_HOST, buildBridgeServer } from './bridge/server.js';
import { Bridge } from './bridge/service.js';
import { readOrCreateBridgeToken } from './bridge/token.js';
import { loadConfig } from './config.js';
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
import { SecretStore, readOrCreateClientId } from './secrets.js';
import { SpeechClient } from './speech.js';
import { Feed } from './feed/service.js';
import { FeedStore } from './feed/store.js';
import { PushSender } from './feed/push.js';
import { SafetyCommandsSetting } from './hermes/safety.js';
import { createAccessVerifier, remoteAccessKeys } from './security/access.js';

// Structured logs to stdout (journald). Never log tokens, cookies or message text.
// LOG_LEVEL uses the request logger's names: trace, debug, info, warn, error, fatal, silent.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const logLevel = process.env.LOG_LEVEL ?? 'info';
const logs = (level: string) => logLevel !== 'silent' && LEVELS.indexOf(level) >= Math.max(0, LEVELS.indexOf(logLevel));
const log: Logger = {
  info: (obj, msg) => {
    if (logs('info')) console.log(JSON.stringify({ level: 'info', msg, ...obj }));
  },
  warn: (obj, msg) => {
    if (logs('warn')) console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
  },
  error: (obj, msg) => {
    if (logs('error')) console.error(JSON.stringify({ level: 'error', msg, ...obj }));
  },
};

const configPath = process.env.SIGNALBOX_CONFIG ?? '/etc/signalbox/config.json';
let loaded;
try {
  loaded = loadConfig(configPath, { allowLocalDev: process.env.SIGNALBOX_DEV_ALLOW_LOOPBACK === '1' });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const config = {
  ...loaded,
  staticDir: loaded.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), '../web'),
};

const hub = new EventHub();
// Who started what, for runs agents start from a shell: kept in the state directory.
const lineage = new Lineage(config.stateDir, log);
// Settings → Security → "Hermes safety commands" (off unless switched on).
const safetyCommands = config.hermes.enabled ? new SafetyCommandsSetting(config.stateDir) : undefined;
const hermes = config.hermes.enabled
  ? new HermesAdapter(config.hermes.url, hub, new SecretStore(config.stateDir), log, {
      secretPrompts: config.hermes.secretPrompts,
      lineage,
      allowSafetyCommands: () => safetyCommands?.enabled() ?? false,
    })
  : new DisabledHermes();
const paseo = config.paseo.enabled
  ? new PaseoAdapter(config.paseo.url, hub, log, readOrCreateClientId(config.stateDir))
  : new DisabledPaseo();
if (paseo instanceof PaseoAdapter) paseo.useLineage(lineage);
hub.onWatchChange((source, id, watching) => (source === 'hermes' ? hermes : paseo).setWatching(id, watching));

// Settings → Scheduled jobs: Hermes' cron jobs, through its dashboard.
const schedules =
  hermes instanceof HermesAdapter || paseo instanceof PaseoAdapter
    ? new Schedules({
        dashboard: () => (hermes instanceof HermesAdapter ? hermes.dashboard() : undefined),
        ...(paseo instanceof PaseoAdapter ? { paseo } : {}),
        assist: new Assist(),
        stateDir: config.stateDir,
        onChanged: () => hub.publish({ type: 'schedules_changed' }),
        log,
      })
    : undefined;

// For you: cards from Hermes' pulse and phone notifications (https only).
const feed = config.feed.enabled
  ? new Feed({
      store: new FeedStore(config.stateDir),
      hub,
      hermes,
      ...(schedules ? { schedules } : {}),
      ...(config.publicOrigin.startsWith('https://')
        ? { push: new PushSender(config.stateDir, config.publicOrigin, log) }
        : {}),
      log,
    })
  : undefined;

// The project bridge, when turned on: its own listener on 127.0.0.1 only, with a
// bearer token. If it can't start, Signalbox runs without it.
let bridge: Bridge | undefined;
let bridgeServer: FastifyInstance | undefined;
if (config.bridge.enabled) {
  const candidate = new Bridge({ sources: { hermes, paseo }, hub, log, port: config.bridge.port, lineage });
  let server: FastifyInstance | undefined;
  try {
    const token = readOrCreateBridgeToken(config.stateDir);
    server = await buildBridgeServer({ bridge: candidate, token, port: config.bridge.port, log, ...(feed ? { feed } : {}) });
    await server.listen({ host: BRIDGE_HOST, port: config.bridge.port });
    bridge = candidate;
    bridgeServer = server;
  } catch (err) {
    await server?.close().catch(() => {});
    log.error({ err: (err as Error).message }, 'the project bridge could not start; running without it');
  }
}

// Settings → Connectors: Hermes' dashboard does the work; the helper (when
// set up) does Google's sign-in and the trigger folders as the Hermes user.
let helper: HelperClient | undefined;
if (config.helper.enabled) {
  const token = readHelperToken();
  if (token) helper = new HelperClient(config.helper.port, token);
  else log.error({}, 'the helper is enabled but its secret is missing (run deploy/setup-helper.sh); Google and triggers are off');
}
const connectors =
  hermes instanceof HermesAdapter
    ? new Connectors({
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
      helper,
      dashboard: () => (hermes instanceof HermesAdapter ? hermes.dashboard() : undefined),
      changed: () => hub.publish({ type: 'skills_changed' }),
      log,
    })
  : undefined;

// Voice mode, when deploy/setup-speech.sh turned it on: the speech service's socket.
const speech = config.speech.enabled ? new SpeechClient(config.speech.socket) : undefined;

const accessKeys = remoteAccessKeys(config.access.jwksUrl, (err) =>
  log.warn({ err: String(err) }, 'could not refresh Cloudflare Access signing keys'),
);
const app = await buildApp({
  config,
  verifier: createAccessVerifier({ ...config.access, keySource: accessKeys.keySource }),
  hub,
  sources: { hermes, paseo },
  logger: { level: logLevel },
  ...(bridge ? { bridge } : {}),
  ...(connectors ? { connectors } : {}),
  ...(schedules ? { schedules } : {}),
  ...(safetyCommands ? { safetyCommands } : {}),
  ...(speech ? { speech } : {}),
  ...(feed ? { feed } : {}),
  // Settings → WhatsApp: the whatsapp-routing Hermes plugin's settings, through the helper.
  ...(connectors && helper ? { whatsappRouting: helper } : {}),
  // Settings → Phone: Hermes Phone's status and PIN, through the helper.
  ...(helper ? { phone: helper } : {}),
  // Settings → Skills, through the helper.
  ...(skills ? { skills } : {}),
});

await app.listen({ host: config.listen.host, port: config.listen.port });
hermes.start();
paseo.start();
feed?.start();
skills?.start();
log.info(
  {
    origin: config.publicOrigin,
    listen: `${config.listen.host}:${config.listen.port}`,
    ...(bridge ? { bridge: `${BRIDGE_HOST}:${config.bridge.port}` } : {}),
    ...(config.hermes.enabled && config.hermes.secretPrompts ? { hermesSecretPrompts: true } : {}),
    ...(speech ? { voice: true } : {}),
    ...(feed ? { forYou: true } : {}),
  },
  'signalbox started',
);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  bridge?.stop();
  feed?.stop();
  await bridgeServer?.close().catch(() => {});
  hermes.stop();
  paseo.stop();
  skills?.stop();
  accessKeys.stop();
  await app.close().catch(() => {});
  lineage.save(); // a report from the last half second isn't lost
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
