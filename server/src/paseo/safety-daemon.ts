import { DaemonClient, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import type { SafetyDaemon } from './safety-setting.js';
import { waitWithAbort } from './abort.js';

/** Uses the supported client API, including password authentication, never a shell or CLI. */
export function createSafetyDaemon(url: string, password?: string): SafetyDaemon {
  const target = new URL(url);
  if (target.pathname === '/') target.pathname = '/ws';
  async function call<T>(work: (client: DaemonClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // close() permanently disposes the SDK client, so each call owns one instance.
    const client = new DaemonClient({
      url: target.toString(), clientId: 'wayroost-safety-helper', clientType: 'cli', appVersion: '0.9.2',
      ...(password ? { password } : {}), connectTimeoutMs: 5_000, reconnect: { enabled: false },
      webSocketFactory: (address, options) => new WebSocket(address, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await waitWithAbort(Promise.race([
        (async () => { await client.connect(); signal?.throwIfAborted(); return work(client); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Paseo Safety request timed out.')), 5_000); }),
      ]), signal);
    } finally {
      clearTimeout(timer);
      await client.close();
    }
  }
  return {
    providers: signal => call(async client => (await client.getProvidersSnapshot()).entries.map(entry => entry.provider), signal),
    effectiveProviders: signal => call(async client => (await client.getDaemonConfig()).config.providers, signal),
    reload: signal => call(client => client.reloadDaemonConfig(), signal),
  };
}
