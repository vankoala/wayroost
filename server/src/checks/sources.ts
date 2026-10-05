// The live sources for the checks page: the settings reads and status the
// supervisor answers, plus what this PC can look at itself — the gateway's role
// listeners, the phone's health answers, the coder MCP's running processes, Hermes'
// drain marker and the desktop switch's flag file. Each one is bounded and answers
// a fixed shape; anything it can't say becomes an unavailable source, which the
// engine turns into "unknown" rows. The paths and addresses come from the server's
// own config, never from a request.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { scriptArgument } from './common.js';
import { drainMarkerSchema, drainExecutorStateSchema, configReadResultSchema, configVerbsStatusSchema, HERMES_DRAIN_PROTOCOL } from '../../../shared/supervisor-config.js';
import { GATEWAY_ROLES, gatewayAdminStatusSchema, gatewayListenersSchema, isLoopbackHost, isLoopbackUrl, type GatewayRole, type GatewayAdminStatus, type GatewayListeners } from '../../../shared/gateway.js';
import { type ReadViewId } from '../../../shared/settings-ops.js';
import { PHONE_QUIET_WINDOW_MS } from './phone.js';
import type { Observation, DirectoryRuleSnapshot } from './snapshot.js';
import { readBounded, readJsonBounded } from '../hub/safe-read.js';
import type { AppConfig } from '../config.js';
import type { SupervisorApi } from '../supervisor-client.js';
import { paseoRuntime } from './paseo-source.js';
import { Checks } from './index.js';
import type { CoderProcess, DrainMarkerSnapshot, GatewaySnapshot, PhoneSnapshot } from './snapshot.js';
import { checksObserveResultSchema } from '../../../shared/supervisor-observations.js';

/** Public gateway probes have a short independent budget. */
export const CHECK_PROBE_TIMEOUT_MS = 1_500;
export const CHECK_PHONE_TIMEOUT_MS = HERMES_DRAIN_PROTOCOL.timing.phoneTimeoutSeconds * 1000;
/** Only so many process folders are looked at, and only their command lines. */
export const MAX_PROC_DIRS = 4096;
const MAX_MARKER_BYTES = 4096;
const MAX_FLAGS_BYTES = 16_384;
const CLOCK_TICKS_PER_SECOND = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** One bounded GET of a loopback service's JSON answer. */
export async function getJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_MARKER_BYTES * 16) { await reader.cancel(); return undefined; }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown };
  } catch {
    return undefined;
  }
}

/** The socket unit that holds the role ports, as systemd's own answer says. */
export function socketUnitState(unit: string, timeoutMs: number): Promise<GatewaySnapshot['socketUnit']> {
  return new Promise(resolve => {
    execFile('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'Result'], { timeout: timeoutMs, maxBuffer: 8192 },
      (error, stdout) => {
        if (error) return resolve(null);
        const lines = new Map(stdout.split('\n').flatMap(line => {
          const [key, value] = line.split('=');
          return value === undefined ? [] : [[key!, value!] as const];
        }));
        const active = lines.get('ActiveState');
        resolve(active === 'active' || active === 'activating' || active === 'inactive' || active === 'failed' ? active : null);
      });
  });
}

/** Seconds since boot, from the kernel's own counter. */
async function uptimeSeconds(procRoot: string): Promise<number> {
  const [first] = (await readFile(join(procRoot, 'uptime'), 'utf8')).trim().split(/\s+/);
  const seconds = Number(first);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('unavailable');
  return seconds;
}

/** When a process started, in epoch milliseconds, from /proc. */
async function processStartedAt(pid: number, uptime: number, now: number, procRoot: string): Promise<number | undefined> {
  try {
    const result = await readBounded(join(procRoot, String(pid), 'stat'), { maxBytes: 8192 });
    if ('refused' in result) return undefined;
    const stat = result.text;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const token = fields[19];
    const startTicks = token && /^[0-9]+$/.test(token) ? int(Number(token)) : undefined;
    return startTicks === undefined ? undefined : Math.round(now - (uptime - startTicks / CLOCK_TICKS_PER_SECOND) * 1000);
  } catch {
    return undefined;
  }
}

/** A running unit's PID is matched to the kernel's process start counter. */
export async function hermesStartedAt(unit: string, now: () => number, procRoot = '/proc'): Promise<number> {
  const pid = await new Promise<number>((resolve, reject) => {
    execFile('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value'],
      { timeout: CHECK_PROBE_TIMEOUT_MS, maxBuffer: 8192,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: '/run/user/' + process.getuid!() } }, (error, stdout) => {
        const token = stdout.trim();
        const value = /^[0-9]+$/.test(token) ? int(Number(token)) : undefined;
        if (error || !value) reject(new Error('unavailable')); else resolve(value);
      });
  });
  const started = await processStartedAt(pid, await uptimeSeconds(procRoot), now(), procRoot);
  if (!started) throw new Error('unavailable');
  return started;
}

/** The running coder MCP processes: start times and which registered script they run. */
export async function coderProcesses(coderMcp: { original: string; gatewayCopy: string } | undefined, now: () => number, procRoot = '/proc'): Promise<CoderProcess[]> {
  if (!coderMcp) return [];
  const uptime = await uptimeSeconds(procRoot);
  const found: CoderProcess[] = [];
  const deadline = Date.now() + CHECK_PROBE_TIMEOUT_MS;
  let pids: string[];
  try {
    pids = (await readdir(procRoot)).filter(name => /^[0-9]+$/.test(name));
    if (pids.length > MAX_PROC_DIRS) throw new Error('unavailable');
  } catch {
    throw new Error('unavailable');
  }
  for (const pid of pids) {
    if (Date.now() > deadline) throw new Error('unavailable');
    let argv: string[] = [];
    try {
      const command = await readBounded(join(procRoot, pid, 'cmdline'), { maxBytes: 16_384 });
      if ('refused' in command) {
        if (command.reason === 'too-large') throw new Error('unavailable');
        continue;
      }
      argv = command.text.split('\0').filter(Boolean);
    } catch { throw new Error('unavailable'); }
    const path = scriptArgument(argv);
    if (!path || ![coderMcp.original, coderMcp.gatewayCopy].some(configured => basename(configured) === basename(path))) continue;
    const script = path === coderMcp.gatewayCopy ? 'gateway-copy' as const
      : path === coderMcp.original ? 'original' as const : 'other' as const;
    const startedAt = await processStartedAt(Number(pid), uptime, now(), procRoot);
    if (startedAt === undefined) throw new Error('unavailable');
    found.push({ startedAt, script });
    if (found.length >= 256) throw new Error('unavailable');
  }
  return found;
}

/** The port an address names, or undefined when it names none. */
function portOf(address: string | undefined): number | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || undefined;
  } catch {
    return undefined;
  }
}

/** Kernel listening sockets are independent of queued HTTP responses. */
export async function heldSocketPorts(procNet = `/proc/${process.pid}/net`): Promise<number[] | null> {
  try {
    const tables = await Promise.all(['tcp', 'tcp6'].map(name => readBounded(join(procNet, name), { maxBytes: 1024 * 1024 })));
    const ports = new Set<number>();
    for (const table of tables) {
      if ('refused' in table || !table.text.includes('local_address')) return null;
      for (const line of table.text.trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (!/^(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{32}):[A-Fa-f0-9]{4}$/.test(fields[1] ?? '') || !/^[A-Fa-f0-9]{2}$/.test(fields[3] ?? '')) return null;
        if (fields[3] !== '0A') continue;
        const [address, port] = fields[1]!.split(':');
        const bytes = address!.match(/../g)!;
        const ip = bytes.length === 4 ? bytes.reverse().map(byte => Number.parseInt(byte, 16)).join('.')
          : Array.from({ length: 4 }, (_, index) => bytes.slice(index * 4, index * 4 + 4).reverse().join('')).join('')
            .match(/.{4}/g)?.join(':');
        if (!/^0+$/.test(address!) && (!ip || !isLoopbackHost(ip))) continue;
        const number = Number.parseInt(port!, 16);
        if (number > 0) ports.add(number);
      }
    }
    return [...ports];
  } catch { return null; }
}

/** Every role listener, socket observation and private status are gathered independently. */
export async function gatewayRoles(addresses: Partial<Record<GatewayRole, string>>, timeoutMs: number, socketUnit: string | undefined,
  readStatus?: () => Promise<Observation<GatewayAdminStatus>>, sockets: () => Promise<number[] | null> = heldSocketPorts,
  readListeners?: () => Promise<Observation<GatewayListeners>>): Promise<GatewaySnapshot> {
  const [roles, unit, listeningPorts, status, listeners] = await Promise.all([
    Promise.all(GATEWAY_ROLES.map(async role => {
      const address = addresses[role];
      if (!address || portOf(address) === undefined) return [role, false] as const;
      const healthz = await getJson(`${new URL(address).origin}/healthz`, timeoutMs);
      return [role, healthz?.status === 200 && isRecord(healthz.body) && healthz.body.status === 'ok'] as const;
    })),
    socketUnit === undefined ? null : socketUnitState(socketUnit, timeoutMs), sockets(),
    readStatus ? readStatus().catch(() => ({ ok: false as const, failure: 'failed' as const }))
      : { ok: false as const, failure: 'not_configured' as const },
    readListeners ? readListeners().catch(() => ({ ok: false as const, failure: 'failed' as const }))
      : { ok: false as const, failure: 'not_configured' as const },
  ]);
  const verified = listeners.ok && listeners.value.unit !== socketUnit
    ? { ok: false as const, failure: 'failed' as const } : listeners;
  return {
    healthz: Object.fromEntries(roles) as GatewaySnapshot['healthz'],
    socketUnit: verified.ok ? verified.value.socketUnit : unit, listeningPorts, status, listeners: verified,
    roles: Object.fromEntries(GATEWAY_ROLES.map(role => [role, { health: status.ok ? status.value.roles[role].health : 'unknown' }])) as GatewaySnapshot['roles'],
    draining: status.ok ? status.value.draining : null,
  };
}

async function gatewayListeners(read: (view: ReadViewId) => Promise<unknown>): Promise<Observation<GatewayListeners>> {
  const result = configReadResultSchema.safeParse(await read('gateway.listeners'));
  if (!result.success || !result.data.ok || !result.data.present || result.data.view !== 'gateway.listeners') return { ok: false, failure: 'failed' };
  const document = Object.fromEntries(result.data.values.filter(entry => entry.exists && entry.path.length === 1)
    .map(entry => [entry.path[0], 'value' in entry ? entry.value : undefined]));
  const listeners = gatewayListenersSchema.safeParse(document);
  return listeners.success ? { ok: true, value: listeners.data } : { ok: false, failure: 'failed' };
}

/** A private read view contains only the gateway's typed runtime status. */
async function gatewayStatus(read: (view: ReadViewId) => Promise<unknown>): Promise<Observation<GatewayAdminStatus>> {
  const result = configReadResultSchema.safeParse(await read('gateway.status'));
  if (!result.success || !result.data.ok || !result.data.present || result.data.view !== 'gateway.status') return { ok: false, failure: 'failed' };
  const document = Object.fromEntries(result.data.values.filter(entry => entry.exists && entry.path.length === 1)
    .map(entry => [entry.path[0], 'value' in entry ? entry.value : undefined]));
  const status = gatewayAdminStatusSchema.safeParse(document);
  return status.success ? { ok: true, value: status.data } : { ok: false, failure: 'failed' };
}

/** Timing is measured over complete, consecutive health observations, never the oldest call. */
export class PhoneObservations {
  private previous?: { at: number; webhooks: number; outboundCalls: number };
  private quietSince?: number;
  private excessSince?: number;
  observe(snapshot: PhoneSnapshot, at: number): PhoneSnapshot {
    const { server, bridge } = snapshot;
    if (!server.ok || !bridge.ok || this.previous && (at < this.previous.at || at - this.previous.at > PHONE_QUIET_WINDOW_MS)) {
      this.previous = undefined; this.quietSince = undefined; this.excessSince = undefined;
    }
    if (!server.ok || !bridge.ok) return { ...snapshot, quietForMs: null, excessForMs: null };
    const quiet = server.value.activeCalls === 0 && bridge.value.activeCalls === 0;
    const unchanged = this.previous?.webhooks === server.value.webhooks && this.previous.outboundCalls === server.value.outboundCalls;
    if (!quiet) this.quietSince = undefined;
    else if (!unchanged || this.quietSince === undefined) this.quietSince = at;
    if (bridge.value.activeCalls <= server.value.activeCalls) this.excessSince = undefined;
    else this.excessSince ??= at;
    this.previous = { at, webhooks: server.value.webhooks, outboundCalls: server.value.outboundCalls };
    return { ...snapshot, quietForMs: quiet ? at - this.quietSince! : 0,
      excessForMs: this.excessSince === undefined ? 0 : at - this.excessSince };
  }
}

/** Read the running bridge's effective pin and both counters within the phone's own budget. */
export async function phoneCounters(phone: { server: string; bridge: string }, timeoutMs: number): Promise<PhoneSnapshot> {
  const [server, bridge] = await Promise.all([
    getJson(`${phone.server.replace(/\/+$/, '')}/health`, timeoutMs), getJson(`${phone.bridge.replace(/\/+$/, '')}/health`, timeoutMs),
  ]);
  const serverBody = isRecord(server?.body) ? server.body : undefined;
  const activeCalls = int(serverBody?.active_calls);
  const webhooks = int(serverBody?.webhooks); const outboundCalls = int(serverBody?.outbound_calls);
  const bridgeBody = isRecord(bridge?.body) ? bridge.body : undefined;
  const bridgeCalls = int(bridgeBody?.active_calls);
  const brains = isRecord(bridgeBody?.brains) ? bridgeBody.brains : undefined;
  const pin = isRecord(brains?.persona) ? brains.persona : undefined;
  return {
    server: activeCalls === undefined || webhooks === undefined || outboundCalls === undefined
      ? { ok: false, failure: 'failed' } : { ok: true, value: { activeCalls, webhooks, outboundCalls } },
    bridge: bridgeCalls === undefined ? { ok: false, failure: 'failed' }
      : { ok: true, value: { activeCalls: bridgeCalls, oldestCallMs: (int(bridgeBody?.oldest_call_seconds) ?? 0) * 1000 } },
    pin: typeof pin?.url === 'string' && pin.url.length <= 2048 && isLoopbackUrl(pin.url) && typeof pin.model === 'string' && pin.model.length > 0 && pin.model.length <= 256
      ? { ok: true, value: { address: pin.url, model: pin.model } } : { ok: false, failure: 'failed' },
  };
}

export async function drainMarker(paths: { path: string; stateFile?: string; executorUnit?: string }): Promise<DrainMarkerSnapshot> {
  const reading = await readJsonBounded(paths.path, { maxBytes: MAX_MARKER_BYTES, root: dirname(paths.path) });
  const state = paths.stateFile ? await readJsonBounded(paths.stateFile, { maxBytes: MAX_MARKER_BYTES, root: dirname(paths.stateFile) }) : undefined;
  const parsedState = state && !('refused' in state) ? drainExecutorStateSchema.safeParse(state.value) : undefined;
  const unit = paths.executorUnit !== undefined ? await socketUnitState(paths.executorUnit, CHECK_PROBE_TIMEOUT_MS) : null;
  const stateAbsent = state && 'refused' in state && state.reason === 'io-error' && state.code === 'ENOENT';
  const running = unit === 'inactive' || unit === 'failed' ? false
    : unit === 'active' && parsedState?.success === true ? true
      : unit === 'active' && stateAbsent ? true : null;
  if ('refused' in reading) {
    if (reading.reason === 'io-error' && reading.code === 'ENOENT') return { present: false, ours: false, requestedAt: 0, drainRunning: running, unreadable: false };
    return { present: true, ours: false, requestedAt: 0, drainRunning: running, unreadable: true };
  }
  const marker = drainMarkerSchema.safeParse(reading.value);
  if (!marker.success) return { present: true, ours: false, requestedAt: 0, drainRunning: running, unreadable: true };
  return { present: true, ours: marker.data.principal === 'wayroost', requestedAt: Date.parse(marker.data.requested_at) || 0,
    drainRunning: running === false ? false : running === true && parsedState?.success === true
      && parsedState.data.marker_requested_at === marker.data.requested_at ? true : null, unreadable: false };
}

export async function switchFlags(path: string): Promise<Record<string, boolean>> {
  const reading = await readJsonBounded(path, { maxBytes: MAX_FLAGS_BYTES, root: dirname(path) });
  if ('refused' in reading || !isRecord(reading.value) || Object.values(reading.value).some(value => typeof value !== 'boolean')) throw new Error('unavailable');
  return Object.fromEntries(Object.entries(reading.value).filter(([, value]) => typeof value === 'boolean') as [string, boolean][]);
}

/** The checks service uses a fresh set of observations for each page load. */
export function buildChecks(config: AppConfig, supervisor: SupervisorApi | undefined,
  sockets: () => Promise<number[] | null> = heldSocketPorts): Checks | undefined {
  const checks = config.checks;
  if (!checks && !supervisor) return undefined;
  const timeoutMs = CHECK_PROBE_TIMEOUT_MS;
  const now = Date.now;
  const addresses = checks?.roleAddresses ?? {};
  const phoneObservations = new PhoneObservations();
  return new Checks(() => {
    const status = supervisor ? supervisor.status() : undefined;
    void status?.catch(() => {});
    const observations = supervisor?.checksObserve?.().then(result => checksObserveResultSchema.parse(result)).catch(() => undefined);
    const ownerObservation = async <K extends 'hermesStartedAt' | 'coderProcesses' | 'drainMarker' | 'switchFlags'>(key: K) => {
      const result = await observations;
      if (!result?.ok || result[key] === null) throw new Error('unavailable');
      return result[key]!;
    };
    const reads = new Map<ReadViewId, Promise<unknown>>();
    const readView = (view: ReadViewId) => {
      let result = reads.get(view);
      if (!result) { result = supervisor!.configRead!({ view }); reads.set(view, result); }
      return result;
    };
    return {
      ...(supervisor?.configRead ? { readView, directoryRule: async (): Promise<DirectoryRuleSnapshot> => {
        const observation = await status;
        const parsed = configVerbsStatusSchema.safeParse(observation?.configVerbs);
        if (!parsed.success || !parsed.data.directories) throw new Error('unavailable');
        const refused = new Set(parsed.data.directories.filter(row => !row.ok).map(row => row.target));
        const passed = new Set(parsed.data.directories.filter(row => row.ok).map(row => row.target));
        return { passed: [...passed].filter(target => !refused.has(target)), refused: [...refused] };
      } } : {}),
      ...(supervisor ? { supervisorStatus: () => status! } : {}),
      ...(supervisor ? { hermesStartedAt: () => ownerObservation('hermesStartedAt') } : {}),
      ...(Object.keys(addresses).length
        ? { gateway: () => gatewayRoles(addresses, timeoutMs, checks?.gatewayUnits?.socket,
          supervisor?.configRead ? () => gatewayStatus(readView) : undefined, sockets,
          supervisor?.configRead ? () => gatewayListeners(readView) : undefined) }
        : {}),
      ...(config.paseo.enabled ? { paseoRuntime: () => paseoRuntime(config.paseo.url) } : {}),
      ...(checks?.phone ? { phone: () => phoneCounters(checks.phone!, CHECK_PHONE_TIMEOUT_MS).then(snapshot => phoneObservations.observe(snapshot, now())) } : {}),
      ...(supervisor ? { coderProcesses: () => ownerObservation('coderProcesses'), drainMarker: () => ownerObservation('drainMarker'),
        switchFlags: () => ownerObservation('switchFlags') } : {}),
    };
  }, {
    ...(Object.keys(addresses).length ? { roleAddresses: addresses } : {}),
    ...(checks?.coderMcp ? { coderMcp: checks.coderMcp } : {}),
    ...(supervisor ? { supervisor: { configWrites: true, statusOnly: config.supervisor?.expectedStatusOnly ?? true } } : {}),
  }, { now, sourceTimeoutMs: timeoutMs + 500, phoneTimeoutMs: CHECK_PHONE_TIMEOUT_MS + 500, gatewayTimeoutMs: 4500, ownerTimeoutMs: 4500, budgetMs: CHECK_PHONE_TIMEOUT_MS + 2000 });
}
