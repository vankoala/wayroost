import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import { GATEWAY_ADMIN_ROUTES, gatewayRoleSchema, gatewayRepointBodySchema, gatewayRepointResultSchema } from '../../shared/gateway.js';
import { socketPathSchema } from '../../shared/settings-targets.js';
import { ConfigError } from './config-paths.js';

export const gatewayPointInputSchema = z.object({ socket: socketPathSchema, role: gatewayRoleSchema, body: gatewayRepointBodySchema }).strict();
export type GatewayAdminRequest = (socket: string, path: string, body: string) => Promise<unknown>;

/** A single HTTP request over the named Unix socket; redirects and backend URLs are never followed. */
export const gatewayAdminRequest: GatewayAdminRequest = (socket, path, body) => new Promise((resolve, reject) => {
  const request = httpRequest({ socketPath: socket, path, method: 'PUT', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, response => {
    let source = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      if (Buffer.byteLength(source) + Buffer.byteLength(chunk) > 4096) request.destroy(new Error());
      else source += chunk;
    });
    response.on('error', reject);
    response.on('end', () => {
      if (response.statusCode !== 200) { reject(new ConfigError('verify_mismatch')); return; }
      try { resolve(JSON.parse(source)); } catch { reject(new ConfigError('verify_mismatch')); }
    });
  });
  const timer = setTimeout(() => request.destroy(new Error()), 5000);
  request.once('close', () => clearTimeout(timer));
  request.on('error', () => reject(new ConfigError('verify_mismatch')));
  request.end(body);
});

export async function executeGatewayPoint(input: unknown, send: GatewayAdminRequest = gatewayAdminRequest) {
  try {
    const parsed = gatewayPointInputSchema.parse(input);
    const result = gatewayRepointResultSchema.parse(await send(parsed.socket, GATEWAY_ADMIN_ROUTES.role(parsed.role), JSON.stringify(parsed.body)));
    if (result.role !== parsed.role || result.backend !== parsed.body.backend) throw new Error();
    return result;
  } catch { return { ok: false as const, code: 'verify_mismatch' as const }; }
}
