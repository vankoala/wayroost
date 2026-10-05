import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { FastifyInstance } from 'fastify';
import { listenerTls } from '../../../lib/loopback-tls.js';
import type { AppConfig } from '../config.js';
import { wayroostEnv } from '../environment.js';

/** Both listeners share authentication, routes, sockets and the settings journal. */
export function localSettingsListener(app: FastifyInstance, config: AppConfig) {
  const server = config.tls ? createHttpsServer(listenerTls(config.tls, process.env, wayroostEnv('DEV_ALLOW_LOOPBACK') === '1'), app.routing)
    : createHttpServer(app.routing);
  server.on('upgrade', (request, socket, head) => app.server.emit('upgrade', request, socket, head));
  app.addHook('preClose', async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return server;
}
