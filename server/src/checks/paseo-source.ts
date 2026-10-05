import { DaemonClient, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { isLoopbackHost } from '../../../shared/gateway.js';
import { readPaseoPassword } from '../paseo/adapter.js';
import type { PaseoRuntimeSnapshot } from './snapshot.js';

export type PaseoChecksClient = Pick<DaemonClient, 'connect' | 'close' | 'fetchAgents' | 'getProvidersSnapshot'>;
const MAX_AGENTS = 256;
const TIMEOUT_MS = 1500;

function clientFor(url: string): PaseoChecksClient {
  const password = readPaseoPassword();
  return new DaemonClient({ url, clientId: 'wayroost-checks', clientType: 'cli', appVersion: '0.9.2',
    ...(password ? { password } : {}), connectTimeoutMs: TIMEOUT_MS, reconnect: { enabled: false },
    webSocketFactory: (target, options) => new WebSocket(target, options?.protocols, { headers: options?.headers, maxPayload: 512 * 1024, followRedirects: false }) as unknown as WebSocketLike,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

/** Read effective providers and existing agent pins through the daemon's supported API. */
export async function paseoRuntime(url: string, factory: (url: string) => PaseoChecksClient = clientFor): Promise<PaseoRuntimeSnapshot> {
  const address = new URL(url);
  if (!['ws:', 'wss:'].includes(address.protocol) || !isLoopbackHost(address.hostname) || address.username || address.password) throw new Error('unavailable');
  if (address.pathname === '/') address.pathname = '/ws';
  const client = factory(address.toString());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      await client.connect();
      const snapshot = await client.getProvidersSnapshot();
      if (snapshot.entries.length > 64) throw new Error('unavailable');
      const providers = Object.fromEntries(snapshot.entries.map(entry => [entry.provider, {
        enabled: entry.enabled, models: (entry.models ?? []).map(model => model.id),
      }]));
      const agents: PaseoRuntimeSnapshot['agents'] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 2; page++) {
        const result = await client.fetchAgents({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of result.entries) agents.push({ id: agent.id, provider: agent.provider, model: agent.model });
        if (agents.length > MAX_AGENTS) throw new Error('unavailable');
        if (!result.pageInfo.hasMore) return { providers, agents };
        cursor = result.pageInfo.nextCursor ?? undefined;
        if (!cursor) throw new Error('unavailable');
      }
      throw new Error('unavailable');
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('unavailable')), TIMEOUT_MS); })]);
  } finally { clearTimeout(timer); await client.close(); }
}
