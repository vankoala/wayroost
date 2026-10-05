import { request } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { GATEWAY_ROLES, gatewayAdminStatusSchema, gatewayListenersSchema, isLoopbackHost, type GatewayListeners } from '../../shared/gateway.js';
import { readBounded } from '../../server/src/hub/safe-read.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { configAuditRowSchema, type ConfigReadResult, type ConfigVerbsStatus } from '../../shared/supervisor-config.js';
import { checkConfigDirectory, digest, readConfigFile } from './config-paths.js';

const ownerQuery = (command: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 750, maxBuffer: 8192, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Every address localhost can select must be loopback and later pass the same ownership checks. */
async function localhostHosts(): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup('localhost', { all: true }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('unavailable')), 750);
    })]);
    if (!addresses.length || addresses.length > 16 || addresses.some(({ address, family }) =>
      !isIP(address) || isIP(address) !== family || !isLoopbackHost(address))) throw new Error('unavailable');
    return [...new Set(addresses.map(({ address, family }) => family === 6 ? new URL(`http://[${address}]`).hostname : address))];
  } finally { clearTimeout(timer); }
}

/** Ports count as held only when the configured unit listens there and PID 1 holds the matching inode. */
export async function readGatewayListeners(site: SettingsTargets, procRoot = '/proc'): Promise<ConfigReadResult> {
  const target = site.targets['gateway-role-map'];
  if (!target || !site.roleAddresses) return { ok: false, code: 'not_configured' };
  try {
    const [output, tables, descriptors] = await Promise.all([
      ownerQuery('systemctl', ['show', target.socket, '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Listen', '-p', 'Triggers']),
      Promise.all(['tcp', 'tcp6'].map(name => readBounded(join(procRoot, '1/net', name), { maxBytes: 1024 * 1024 }))),
      readdir(join(procRoot, '1/fd')),
    ]);
    if (descriptors.length > 16_384) throw new Error('unavailable');
    const deadline = Date.now() + 1000;
    const managerInodes = new Set<string>();
    for (const descriptor of descriptors) {
      if (Date.now() > deadline || !/^[0-9]+$/.test(descriptor)) throw new Error('unavailable');
      const link = await readlink(join(procRoot, '1/fd', descriptor)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      const inode = link.match(/^socket:\[([0-9]+)\]$/)?.[1];
      if (inode) managerInodes.add(inode);
    }
    const properties = new Map(output.trim().split('\n').map(line => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error('unavailable');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    }));
    const state = properties.get('ActiveState');
    if (properties.get('Id') !== target.socket || properties.get('LoadState') !== 'loaded'
      || !['active', 'activating', 'inactive', 'failed'].includes(state ?? '')) throw new Error('unavailable');
    const configured = [...(properties.get('Listen') ?? '').matchAll(/(\S+) \(Stream\)/g)].map(match => match[1]!);
    const associated = (properties.get('Triggers') ?? '').split(/\s+/).includes(target.service);
    const sockets: { endpoint: string; uid: number; inode: string }[] = [];
    for (const [index, table] of tables.entries()) {
      if ('refused' in table || !table.text.includes('local_address')) throw new Error('unavailable');
      for (const line of table.text.trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (!new RegExp(`^[A-Fa-f0-9]{${index ? 32 : 8}}:[A-Fa-f0-9]{4}$`).test(fields[1] ?? '')
          || !/^[A-Fa-f0-9]{2}$/.test(fields[3] ?? '')) throw new Error('unavailable');
        if (fields[3]!.toUpperCase() !== '0A') continue;
        if (!/^[0-9]+$/.test(fields[7] ?? '') || !/^[1-9][0-9]*$/.test(fields[9] ?? '')) throw new Error('unavailable');
        const [address, port] = fields[1]!.toUpperCase().split(':');
        sockets.push({ endpoint: `${address}:${Number.parseInt(port!, 16)}`, uid: Number(fields[7]), inode: fields[9]! });
      }
    }
    const localhost = Object.values(site.roleAddresses).some(address => new URL(address).hostname === 'localhost')
      ? await localhostHosts() : [];
    const roles = Object.fromEntries(GATEWAY_ROLES.map(role => {
      const address = site.roleAddresses![role];
      const url = new URL(address);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const hosts = url.hostname === 'localhost' ? localhost : [url.hostname];
      const endpoints = hosts.map(hostname => {
        const host = hostname === '[::1]' ? '00000000000000000000000001000000'
          : hostname.split('.').reverse().map(part => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase();
        return { configured: configured.includes(`${hostname}:${port}`), matches: sockets.filter(socket => socket.endpoint === `${host}:${port}`) };
      });
      const held = associated && endpoints.some(({ configured }) => configured)
        && endpoints.every(({ configured, matches }) => !configured && matches.length === 0
          || configured && matches.length === 1 && matches[0]!.uid === 0 && managerInodes.has(matches[0]!.inode));
      return [role, { address, state: held ? 'held' : endpoints.some(({ matches }) => matches.length) ? 'foreign' : 'missing' }];
    })) as GatewayListeners['roles'];
    const value = gatewayListenersSchema.parse({ unit: target.socket, socketUnit: state, roles });
    return { ok: true, view: 'gateway.listeners', present: true, sha256: digest(JSON.stringify(value)),
      values: Object.entries(value).map(([name, value]) => ({ path: [name], exists: true as const, value })) };
  } catch { return { ok: false, code: 'unavailable' }; }
}

/** Resolve the configured service's dynamic account before applying the owner directory rule. */
export async function gatewayOwnerUid(site: SettingsTargets): Promise<number> {
  const target = site.targets['gateway-role-map'];
  if (!target) throw new Error('unavailable');
  const properties = new Map((await ownerQuery('systemctl', ['show', target.service, '-p', 'DynamicUser', '-p', 'User']))
    .trim().split('\n').map(line => line.split('=') as [string, string]));
  const user = properties.get('User');
  if (properties.get('DynamicUser') !== 'yes' || !user || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) throw new Error('unavailable');
  const line = (await ownerQuery('getent', ['passwd', user])).trim();
  const fields = line.split(':');
  const uid = /^[0-9]+$/.test(fields[2] ?? '') ? Number(fields[2]) : NaN;
  if (line.includes('\n') || fields.length !== 7 || fields[0] !== user || !Number.isSafeInteger(uid) || uid <= 0 || uid >= 4_294_967_295) throw new Error('unavailable');
  return uid;
}

/** Summarize unresolved failures from durable audit evidence; unrelated rows never retire them. */
export async function readGatewayPersistence(directory: string, uid = process.getuid!()): Promise<NonNullable<ConfigVerbsStatus['gatewayPersistence']>> {
  let file;
  try {
    const path = join(directory, 'config-audit.jsonl');
    await checkConfigDirectory(path, uid);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4 * 1024 * 1024) throw new Error('unavailable');
    const failed = new Map<string, string>();
    const buffer = Buffer.alloc(65_536);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const deadline = Date.now() + 1000;
    let offset = 0; let pending = '';
    while (offset < stat.size) {
      if (Date.now() > deadline) throw new Error('unavailable');
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) throw new Error('unavailable');
      offset += bytesRead;
      pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < stat.size });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('unavailable');
        let row = configAuditRowSchema.parse(JSON.parse(line));
        if (row.target !== 'gateway-state' || row.verb !== 'config.apply' || !['gateway.record-migration', 'gateway.record-override'].includes(row.operation ?? '')) continue;
        const change = row.change ?? row.id;
        const key = JSON.stringify([row.operation, change]);
        if (row.result === 'verify_mismatch') failed.set(key, change);
        else if (row.result === 'ok') failed.delete(key);
        if (failed.size > 64) throw new Error('unavailable');
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Error('unavailable');
    }
    if (pending || (await file.stat()).size !== stat.size) throw new Error('unavailable');
    return { ok: true, failedChanges: [...new Set(failed.values())] };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, failedChanges: [] } : { ok: false, code: 'unavailable' };
  } finally { await file?.close(); }
}

/** Only a configured gateway owner's private socket can supply the runtime view. */
export async function readGatewayStatus(site: SettingsTargets, owner = gatewayOwnerUid): Promise<ConfigReadResult> {
  const target = site.targets['gateway-role-map'];
  if (!target) return { ok: false, code: 'not_configured' };
  try {
    const [stat, map] = await Promise.all([lstat(target.adminSocket), lstat(target.path)]);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.mode & 0o077 || !map.isFile() || map.isSymbolicLink()
      || map.uid !== stat.uid || map.mode & 0o022) return { ok: false, code: 'unsafe_target' };
    if (stat.uid !== await owner(site)) return { ok: false, code: 'unsafe_target' };
    await checkConfigDirectory(target.adminSocket, stat.uid);
    await checkConfigDirectory(target.path, stat.uid);
    const probe = (path: string) => new Promise<unknown>((resolve, reject) => {
      const client = request({ socketPath: target.adminSocket, path, method: 'GET',
        signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) { response.destroy(); reject(new Error('unavailable')); }
          else chunks.push(chunk);
        });
        response.once('error', reject); response.once('aborted', () => reject(new Error('unavailable')));
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('unavailable');
            resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
          } catch (error) { reject(error); }
        });
      });
      client.once('error', reject); client.end();
    });
    const [health, status] = await Promise.all([probe('/healthz'), probe('/v1/status')]);
    if (!health || typeof health !== 'object' || !('status' in health) || health.status !== 'ok') throw new Error('unavailable');
    const value = gatewayAdminStatusSchema.parse(status);
    return { ok: true, view: 'gateway.status', present: true, sha256: digest(JSON.stringify(value)), values: [
      { path: ['roles'], exists: true, value: value.roles }, { path: ['draining'], exists: true, value: value.draining },
    ] };
  } catch { return { ok: false, code: 'unavailable' }; }
}

type AgentId = 'claude' | 'codex' | 'copilot';
interface CommandResult { code: number; stdout: string; stderr: string }
export interface SettingsReaderDependencies {
  command?: (path: string, args: string[], home: string) => Promise<CommandResult>;
  copilot?: (path: string, home: string) => Promise<boolean>;
}

/** Fixed status commands run with a small output budget and no inherited credentials. */
function statusCommand(path: string, args: string[], home: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, cwd: '/',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' } }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error);
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** The CLI's stdio status RPC does not create a session or ask a model anything. */
function copilotStatus(path: string, home: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['--headless', '--no-auto-update', '--stdio'], { cwd: '/', shell: false, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' } });
    let pending = Buffer.alloc(0); let size = 0; let settled = false;
    const finish = (value?: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGKILL');
      if (value === undefined) reject(new Error('unavailable')); else resolve(value);
    };
    const timer = setTimeout(() => finish(), 2000);
    child.once('error', () => finish()); child.once('close', () => finish()); child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) { finish(); return; }
      pending = Buffer.concat([pending, chunk]);
      while (!settled) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = pending.subarray(0, end).toString('ascii');
        const length = Number(header.match(/^Content-Length: ([0-9]+)$/im)?.[1]);
        if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024) { finish(); return; }
        if (pending.length < end + 4 + length) return;
        const body = pending.subarray(end + 4, end + 4 + length); pending = pending.subarray(end + 4 + length);
        try {
          const reply = z.object({ id: z.literal(1), result: z.object({ isAuthenticated: z.boolean() }) }).safeParse(JSON.parse(body.toString('utf8')));
          if (reply.success) finish(reply.data.result.isAuthenticated);
          else finish();
        } catch { finish(); }
      }
    });
    child.stdout.once('error', () => finish());
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.getStatus', params: {} });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
}

/** Status only: raw command output, identities and credentials never reach a page. */
export async function readAgentAvailability(config: Pick<NonNullable<SettingsTargets['agentStatus']>, 'home' | 'binaries'> | undefined, dependencies: SettingsReaderDependencies = {}) {
  return Promise.all((['claude', 'codex', 'copilot'] as const).map(async (id: AgentId) => {
    const path = config?.binaries[id];
    if (!config || !path) return { id, installed: null, authenticated: null };
    let installed: boolean | null = null;
    try {
      const version = await (dependencies.command ?? statusCommand)(path, ['--version'], config.home);
      if (version.code !== 0) return { id, installed, authenticated: null };
      installed = true;
      let authenticated: boolean | null = null;
      if (id === 'copilot') authenticated = await (dependencies.copilot ?? copilotStatus)(path, config.home);
      else {
        const status = await (dependencies.command ?? statusCommand)(path, id === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], config.home);
        if (id === 'claude') {
          const parsed = z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(status.stdout));
          if (parsed.success && (status.code === 0 || status.code === 1)) authenticated = parsed.data.loggedIn;
        } else {
          const text = `${status.stdout}\n${status.stderr}`;
          if (status.code === 0 && /^Logged in using (?:ChatGPT|an API key|API key)/m.test(text)) authenticated = true;
          else if (status.code === 1 && /^Not logged in\s*$/m.test(text)) authenticated = false;
        }
      }
      return { id, installed, authenticated };
    } catch (error) {
      return { id, installed: installed ?? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null), authenticated: null };
    }
  }));
}
