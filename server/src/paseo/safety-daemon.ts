import { DaemonClient, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import type { SafetyDaemon } from './safety-setting.js';

/** Uses the supported client API, including password authentication, never a shell or CLI. */
export function createSafetyDaemon(url: string, password?: string): SafetyDaemon {
  const target = new URL(url);
  if (target.pathname === '/') target.pathname = '/ws';
  async function call<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
    // close() permanently disposes the SDK client, so each call owns one instance.
    const client = new DaemonClient({
      url: target.toString(), clientId: 'wayroost-safety-helper', clientType: 'cli', appVersion: '0.9.2',
      ...(password ? { password } : {}), connectTimeoutMs: 5_000, reconnect: { enabled: false },
      webSocketFactory: (address, options) => new WebSocket(address, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { await client.connect(); return work(client); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Paseo Safety request timed out.')), 5_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      await client.close();
    }
  }
  return {
    providers: () => call(async client => (await client.getProvidersSnapshot()).entries.map(entry => entry.provider)),
    effectiveProviders: () => call(async client => (await client.getDaemonConfig()).config.providers),
    reload: () => call(client => client.reloadDaemonConfig()),
  };
}
