import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { decideChange, decideRead, isSettingsPolicyRoute, routePolicy, routePolicyLevel, rowAccess,
  type SettingsRequestContext } from '../../../shared/settings-levels.js';

export { decideChange, decideRead, isSettingsPolicyRoute, routePolicy, routePolicyLevel, rowAccess };

/** Listener identity comes from the accepted socket, independent of client headers. */
export function settingsContext(request: FastifyRequest, config: AppConfig): SettingsRequestContext {
  return {
    role: config.role,
    scopes: request.device?.scopes ?? [],
    listener: config.localListener && request.raw.socket.localPort === config.localListener.port ? 'local' : 'main',
    pcOnlyWrites: config.localListener?.pcOnlyWrites ?? false,
    confirmed: false,
  };
}
