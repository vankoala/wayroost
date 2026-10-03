// Spike for "Workers' approvals come to me": does a Paseo daemon
// refuse the agent tools that agents.providers.<id>.paseoTools takes away, when an agent of
// that provider calls them? A real daemon runs in-process (isolated paseoHome and HOME,
// development port 8892 or 8893 like run.ts, so run the two one after the other, and a
// daemon password like the live one). Its agents are fake-acp-agent.mjs
// under the role provider ids, and they call Paseo's tools the way real agents do: through
// the "paseo" MCP server Paseo hands each session. The option is switched the way Wayroost
// will switch it: safety-config.ts merges it into config.json (and undoes it from its
// backup), then `paseo daemon reload` (the client's reloadDaemonConfig).
// Known gaps are reported as GAP lines and don't fail the run. Nothing touches your own
// daemon, and nothing in your home: the check fails if your real skill folders change.
//
//   npm install --prefix /tmp/paseo-X @getpaseo/server@X       (0.9 or later)
//   npx tsx scripts/paseo-compat/tool-policy.ts /tmp/paseo-X/node_modules/@getpaseo/server
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { EventHub } from '../../server/src/hub.js';
import { PaseoAdapter } from '../../server/src/paseo/adapter.js';
import { isolateHome } from './isolated-home.js';
import { startCompatDaemon } from './isolation.js';
import {
  APPROVAL_TOOLS,
  ROLE_PROVIDERS,
  applyApprovalsToMe,
  undoApprovalsToMe,
  withRoleProviders,
  type Providers,
} from '../../server/src/paseo/safety-config.js';
import { BackgroundGate } from '../../server/src/background.js';

const serverDir = resolve(process.argv[2] ?? '');
const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version as string;
const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
const root = mkdtempSync(join(tmpdir(), 'sb-paseo-tools-'));
const realHomeUntouched = isolateHome(root); // before Paseo is loaded
const fromServer = createRequire(join(serverDir, 'package.json'));
const load = (path: string) => import(pathToFileURL(path).href);
const { createPaseoDaemon } = await load(join(serverDir, 'dist/server/server/bootstrap.js'));
const { hashDaemonPassword } = await load(join(serverDir, 'dist/server/server/auth.js'));
const { PersistedConfigSchema } = await load(join(serverDir, 'dist/server/server/persisted-config.js'));
const { DaemonClient } = await load(fromServer.resolve('@getpaseo/client/internal/daemon-client'));
// The installed daemon's own list of built-in providers, so a new one is turned off too.
const { BUILTIN_PROVIDER_IDS } = await load(fromServer.resolve('@getpaseo/protocol/provider-manifest'));
const pino = fromServer('pino');

const paseoHome = join(root, '.paseo');
const project = join(root, 'project');
const staticDir = join(root, 'static');
const credentials = join(root, 'credentials');
for (const dir of [paseoHome, project, staticDir, credentials]) mkdirSync(dir, { recursive: true });
const password = randomBytes(18).toString('hex');
writeFileSync(join(credentials, 'paseo-password'), password);
process.env.CREDENTIALS_DIRECTORY = credentials; // how systemd hands Wayroost the daemon password

const fake = (...args: string[]) => ({ extends: 'acp', command: [process.execPath, fakeAgent, ...args] });
/**
 * config.json's providers before the option: the real CLIs off, the roles (as M1 adds
 * them) and two more providers played by the fake agent. "hermes" stands in for a custom
 * provider that already has a tool of its own off, to show the option merges with it.
 */
const userProviders: Providers = withRoleProviders({
  ...Object.fromEntries((BUILTIN_PROVIDER_IDS as string[]).map((id) => [id, { enabled: false }])),
  'coder-lead': fake(),
  'coder-worker': fake(),
  reviewer: fake(),
  fakemodes: { ...fake('--modes'), label: 'Fake ACP with modes' },
  hermes: { ...fake(), label: 'Hermes', paseoTools: { disabledTools: ['create_terminal'] } },
});
const optionOn = applyApprovalsToMe(userProviders);
const optionOff = undoApprovalsToMe(optionOn.providers, optionOn.backup);

function writeConfig(providers: Providers) {
  const config = {
    version: 1,
    daemon: { hostnames: true, cors: { allowedOrigins: [] }, relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true } },
    agents: { providers },
  };
  writeFileSync(join(paseoHome, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

writeConfig(userProviders);
async function startDaemon(listen: string) {
  const started = await createPaseoDaemon(
    {
      listen,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: join(paseoHome, 'agents'),
      relayEnabled: false,
      relayEndpoint: 'relay.paseo.sh:443',
      appBaseUrl: 'https://app.paseo.sh',
      auth: { password: hashDaemonPassword(password) },
      providerOverrides: userProviders,
    },
    pino({ level: process.env.PASEO_LOG ?? 'silent' }),
  );
  try {
    await started.start();
    return started;
  } catch (err) {
    await started.stop().catch(() => {});
    throw err;
  }
}
const daemon = await startCompatDaemon(startDaemon);
const target = daemon.getListenTarget();
const port = target.type === 'tcp' ? target.port : 0;

const hub = new EventHub();
const log = { info() {}, warn: (o: object, m?: string) => console.warn('  warn:', m, JSON.stringify(o)), error: (o: object, m?: string) => console.error('  error:', m, JSON.stringify(o)) };
// The check plays the primary: catch-ups and reloads run as they do live.
const adapter = new PaseoAdapter(`ws://127.0.0.1:${port}`, hub, log, 'cid_signalbox_tools', undefined, new BackgroundGate('primary'));

/** What `paseo daemon reload` does: re-read config.json and apply what can change live. */
async function reloadConfig(): Promise<{ appliedPaths: string[] }> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: 'cid_compat_reload',
    clientType: 'cli',
    password,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    webSocketFactory: (url: string, options?: { protocols?: string[]; headers?: Record<string, string> }) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  await client.connect();
  try {
    return await client.reloadDaemonConfig();
  } finally {
    await client.close();
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
function pass(cond: boolean, what: string, detail = '') {
  if (!cond) throw new Error(`${what}${detail ? ` (${detail})` : ''}`);
  console.log(`  ✓ ${what}${detail ? `: ${detail}` : ''}`);
}
function gap(open: boolean, what: string, detail: string) {
  console.log(open ? `  GAP ${what}: ${detail}` : `  closed (was a gap) ${what}: ${detail}`);
}

interface ToolOutcome {
  tag?: string;
  tools?: string[];
  listed?: boolean;
  ok?: true;
  refused?: string;
  error?: string;
}
let tags = 0;
const NO_SERVER = 'no paseo MCP server in this session';
/**
 * An agent (an existing one, or a new one of a provider) calls one of Paseo's tools; what it
 * reported. With `noServer`, the agent must have been given no Paseo MCP server at all.
 */
async function agentCalls(
  who: { agentId: string } | { providerId: string },
  request: { tool?: string; args?: object; dropCaller?: boolean },
  { noServer = false } = {},
): Promise<{ agentId: string; outcome: ToolOutcome }> {
  const tag = `t${++tags}`;
  const text = `mcp-call ${JSON.stringify({ tag, ...request })}`;
  let agentId: string;
  if ('agentId' in who) {
    agentId = who.agentId;
    await adapter.sendMessage(agentId, text);
  } else {
    agentId = await adapter.createConversation({ providerId: who.providerId, cwd: project, text, acknowledgeAutoApprove: true });
  }
  let outcome: ToolOutcome | undefined;
  await until(`agent ${agentId.slice(0, 8)} reports ${request.tool ?? 'its tools'}`, async () => {
    const last = ((await daemon.agentManager.getLastAssistantMessage(agentId)) as string | null) ?? '';
    const said = last.startsWith('MCP ') ? (JSON.parse(last.slice(4)) as ToolOutcome) : undefined;
    if (said?.tag === tag) outcome = said;
    return outcome !== undefined;
  });
  if (noServer && outcome?.error !== NO_SERVER) throw new Error(`expected no Paseo MCP server, got ${JSON.stringify(outcome)}`);
  if (!noServer && outcome?.error) throw new Error(`agent could not reach Paseo's tools: ${outcome.error}`);
  await until('agent idle', async () => (await adapter.listConversations()).some((c) => c.id === agentId && c.status === 'idle'));
  return { agentId, outcome: outcome! };
}
const toolsOf = async (providerId: string) => (await agentCalls({ providerId }, {})).outcome.tools ?? [];
const waiting = (agentId: string) => adapter.listApprovals().some((a) => a.conversationId === agentId);
/** A coder-worker that asks for one permission; its id and the request id. */
async function workerAsking(): Promise<{ worker: string; requestId: string }> {
  const worker = await adapter.createConversation({ providerId: 'coder-worker', cwd: project, text: 'Please ask permission, then say hello', acknowledgeAutoApprove: true });
  await until('worker permission request reaches Wayroost', () => waiting(worker));
  const requestId = [...daemon.agentManager.getAgent(worker).pendingPermissions.keys()][0] as string;
  return { worker, requestId };
}
const answer = (agentId: string, requestId: string) => ({ agentId, requestId, response: { behavior: 'allow' } });
const modeOf = (agentId: string) => daemon.agentManager.getAgent(agentId)?.currentModeId as string | null;
const lacks = (tools: string[], ...names: string[]) => names.every((name) => !tools.includes(name));
/** Workers and reviewers get no Paseo MCP server, so neither the tools nor the token reach them. */
async function noPaseoTools(providerId: string, what: string) {
  await agentCalls({ providerId }, { tool: 'create_agent', args: { provider: providerId, initialPrompt: 'hi' } }, { noServer: true });
  pass(true, what, 'no Paseo MCP server in its session, so no tools and no token');
}

let failed = false;
try {
  console.log(`Paseo ${version} tool limits (daemon on port ${port}, password on)`);
  // A realistic config: custom providers keep their own extends, label and command, and the roles are based on pi.
  const realistic = withRoleProviders({ hermes: { extends: 'acp', label: 'Hermes', command: ['hermes', 'acp'] }, claude: { paseoTools: { enabled: false } } });
  const realisticOn = applyApprovalsToMe(realistic);
  for (const providers of [realistic, realisticOn.providers, undoApprovalsToMe(realisticOn.providers, realisticOn.backup), userProviders, optionOn.providers, optionOff]) {
    PersistedConfigSchema.parse({ version: 1, agents: { providers } });
  }
  pass(true, 'the M1 config, option on and off, is valid Paseo config.json');
  pass(JSON.stringify(optionOff) === JSON.stringify(userProviders), 'undo gives back config.json exactly as it was');
  // A plugin provider has no config entry; a limit-only one isn't valid, and a full one would clash with the plugin.
  const pluginLimit = PersistedConfigSchema.safeParse({ version: 1, agents: { providers: { 'example-plugin': { paseoTools: { disabledTools: [...APPROVAL_TOOLS] } } } } });
  pass(!pluginLimit.success, "a limit-only entry for a plugin's provider is rejected", pluginLimit.error?.issues[0]?.message);
  adapter.start();
  await until('connected', () => adapter.status().state === 'connected');
  const offered = (await adapter.options()).providers.map((p) => p.id);
  pass(Object.keys(ROLE_PROVIDERS).every((id) => offered.includes(id)), 'role providers offered', Object.keys(ROLE_PROVIDERS).join(', '));

  console.log('Option off');
  await noPaseoTools('coder-worker', 'a worker has no Paseo agent tools, so no create_agent');
  await noPaseoTools('reviewer', 'a reviewer has no Paseo agent tools either');
  const first = await workerAsking();
  const before = await agentCalls({ providerId: 'coder-lead' }, { tool: 'respond_to_permission', args: answer(first.worker, first.requestId) });
  const leadBeforeReload = before.agentId;
  pass(before.outcome.ok === true, "the lead answers its worker's permission request");
  await until('request cleared', () => !waiting(first.worker));
  const moded = await adapter.createConversation({ providerId: 'fakemodes', cwd: project, text: 'Again' });
  // Since 0.9.2 the agent's process starts when its timeline is loaded.
  await adapter.getConversation(moded);
  await until('agent with modes idle', async () => (await adapter.listConversations()).some((c) => c.id === moded && c.status === 'idle'));
  const modeSwitch = await agentCalls({ agentId: leadBeforeReload }, { tool: 'set_agent_mode', args: { agentId: moded, modeId: 'auto' } });
  pass(modeSwitch.outcome.ok === true && modeOf(moded) === 'auto', "the lead switches another agent's mode", `mode ${modeOf(moded)}`);
  const hermesOff = await toolsOf('hermes');
  pass(lacks(hermesOff, 'create_terminal') && hermesOff.includes('respond_to_permission'), 'Hermes has only its own limit off', 'create_terminal');

  console.log('Option on (merged into config.json, then daemon reload)');
  writeConfig(optionOn.providers);
  const reloaded = await reloadConfig();
  pass(reloaded.appliedPaths.includes('agents.providers'), 'reload applied the provider limits', reloaded.appliedPaths.join(', '));
  const second = await workerAsking();
  const lead = await agentCalls({ providerId: 'coder-lead' }, { tool: 'respond_to_permission', args: answer(second.worker, second.requestId) });
  pass(lead.outcome.listed === false && !!lead.outcome.refused, 'a new lead calling respond_to_permission is refused', lead.outcome.refused);
  await new Promise((r) => setTimeout(r, 500));
  pass(waiting(second.worker), 'the request is still waiting for you in Wayroost');
  const blocked = await agentCalls({ agentId: lead.agentId }, { tool: 'set_agent_mode', args: { agentId: moded, modeId: 'ask' } });
  pass(!!blocked.outcome.refused && modeOf(moded) === 'auto', 'the lead calling set_agent_mode is refused', `${blocked.outcome.refused}; mode still ${modeOf(moded)}`);
  const sideDoor = await agentCalls({ agentId: lead.agentId }, { tool: 'update_agent', args: { agentId: moded, settings: { modeId: 'ask' } } });
  pass(!!sideDoor.outcome.refused && modeOf(moded) === 'auto', 'the lead calling update_agent to change a mode is refused', `${sideDoor.outcome.refused}; mode still ${modeOf(moded)}`);
  const leadTools = (await agentCalls({ agentId: lead.agentId }, {})).outcome.tools ?? [];
  pass(leadTools.includes('create_agent') && lacks(leadTools, ...APPROVAL_TOOLS), 'the lead keeps create_agent, loses the approval tools', APPROVAL_TOOLS.join(', '));
  const hermesOn = await toolsOf('hermes');
  pass(lacks(hermesOn, 'create_terminal', ...APPROVAL_TOOLS), 'Hermes keeps its own limit and loses the approval tools too');
  await noPaseoTools('coder-worker', "a worker's tools stay off through the merge");
  await noPaseoTools('reviewer', "a reviewer's tools stay off through the merge");

  console.log('Known gaps');
  const stale = await agentCalls({ agentId: leadBeforeReload }, { tool: 'respond_to_permission', args: answer(second.worker, second.requestId) });
  gap(stale.outcome.ok === true, 'reload is not retroactive', stale.outcome.ok ? 'a lead started before the reload still answered the request' : `refused: ${stale.outcome.refused}`);
  const third = await workerAsking();
  const bypass = await agentCalls({ agentId: lead.agentId }, { tool: 'respond_to_permission', args: answer(third.worker, third.requestId), dropCaller: true });
  gap(
    bypass.outcome.ok === true,
    'callerAgentId is only a URL parameter',
    bypass.outcome.ok ? 'the limited lead answered it through the same URL and token without ?callerAgentId' : `refused: ${bypass.outcome.refused}`,
  );

  console.log('Option off again (undo from the backup, then daemon reload)');
  writeConfig(optionOff);
  await reloadConfig();
  const fourth = await workerAsking();
  const after = await agentCalls({ providerId: 'coder-lead' }, { tool: 'respond_to_permission', args: answer(fourth.worker, fourth.requestId) });
  pass(after.outcome.ok === true, 'a new lead can answer again');
  await until('request cleared', () => !waiting(fourth.worker));
  const hermesUndone = await toolsOf('hermes');
  pass(lacks(hermesUndone, 'create_terminal') && hermesUndone.includes('respond_to_permission'), 'Hermes still has its own limit off', 'create_terminal');
  await noPaseoTools('coder-worker', "a worker's tools are still off");
} catch (err) {
  failed = true;
  console.error(`FAIL  Paseo ${version} tool limits: ${(err as Error).message}`);
} finally {
  adapter.stop();
  await daemon.stop().catch(() => {});
  if (!realHomeUntouched()) failed = true;
  // A provider CLI Paseo probed may still be writing its cache into the temp home.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`  warn: could not remove ${root}: ${(err as Error).message}`);
  }
}
if (!failed) console.log(`PASS  Paseo ${version} tool limits`);
process.exit(failed ? 1 : 0);
