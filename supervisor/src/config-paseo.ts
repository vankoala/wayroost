import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DaemonClient, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { isLoopbackHost } from '../../shared/gateway.js';
import { PASEO_AGENT_PROVIDERS } from '../../shared/settings-ops.js';
import type { ConfigReadResult } from '../../shared/supervisor-config.js';
import { ConfigError } from './config-paths.js';

export type PaseoExpectedConfig = Extract<ConfigReadResult, { ok: true }>;
export type PaseoReload = (expected: PaseoExpectedConfig) => Promise<boolean>;
export interface PaseoReloadClient {
  reload(): Promise<{ restartRequiredPaths: string[]; overrideControlledPaths: string[] }>;
  effectiveConfig(): Promise<unknown>;
}

function paseoClient(url: string, password?: string): PaseoReloadClient {
  async function call<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
    const address = new URL(url); if (address.pathname === '/') address.pathname = '/ws';
    const daemon = new DaemonClient({ url: address.toString(), clientId: 'wayroost-config', clientType: 'cli', appVersion: '0.9.2',
      ...(password ? { password } : {}), connectTimeoutMs: 5000, reconnect: { enabled: false },
      webSocketFactory: (target, options) => new WebSocket(target, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => { await daemon.connect(); return work(daemon); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConfigError('timeout')), 5000); })]);
    } finally { clearTimeout(timer); await daemon.close(); }
  }
  return { reload: () => call(daemon => daemon.reloadDaemonConfig()), effectiveConfig: () => call(async daemon => (await daemon.getDaemonConfig()).config) };
}

/** Reload outside the isolated writer unit, through the supported daemon API. */
export function createPaseoReload(url: string, password?: string,
  client: (url: string, password?: string) => PaseoReloadClient = paseoClient): PaseoReload {
  let address: URL;
  try { address = new URL(url); } catch { throw new ConfigError('not_configured'); }
  if (!['ws:', 'wss:'].includes(address.protocol) || !isLoopbackHost(address.hostname) || address.username || address.password) throw new ConfigError('not_configured');
  const daemon = client(address.toString(), password);
  return async expected => {
    try {
      if (!expected.present || expected.view !== 'paseo.agents') return false;
      const result = await daemon.reload();
      if (result.restartRequiredPaths.length || result.overrideControlledPaths.length) return false;
      const effective = await daemon.effectiveConfig();
      const values = [...expected.values];
      // Removed provider entries still have an effective enabled default.
      for (const provider of PASEO_AGENT_PROVIDERS) {
        const path = ['agents', 'providers', provider, 'enabled'];
        if (!values.some(entry => isDeepStrictEqual(entry.path, path))) values.push({ path, exists: false });
      }
      return values.every(entry => {
        const path = entry.path[0] === 'agents' ? entry.path.slice(1) : entry.path[0] === 'daemon' ? entry.path.slice(1) : undefined;
        if (!path) return false;
        let current = effective;
        for (const segment of path) {
          if (typeof segment === 'object') return false;
          current = current && typeof current === 'object' && Object.hasOwn(current, segment) ? (current as Record<string | number, unknown>)[segment] : undefined;
        }
        if (entry.exists) return 'value' in entry && isDeepStrictEqual(entry.value, current);
        const leaf = path.at(-1);
        return current === undefined || leaf === 'appendSystemPrompt' && current === '' || leaf === 'enabled' && current === true;
      });
    } catch { return false; }
  };
}

/** Connection credentials come from the root unit, never the owner's config. */
export async function configuredPaseoReload(env: NodeJS.ProcessEnv = process.env): Promise<PaseoReload | undefined> {
  if (!env.WAYROOST_PASEO_URL) return undefined;
  let password: string | undefined;
  if (env.CREDENTIALS_DIRECTORY) {
    try { password = (await readFile(join(env.CREDENTIALS_DIRECTORY, 'paseo-password'), 'utf8')).trim() || undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError('not_configured'); }
  }
  return createPaseoReload(env.WAYROOST_PASEO_URL, password);
}
