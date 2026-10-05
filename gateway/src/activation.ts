import { GATEWAY_ROLES, type GatewayRole } from '../../shared/gateway.js';

/** systemd passes descriptors in the socket unit's ListenStream order. */
export function inheritedListeners(environment: NodeJS.ProcessEnv, pid: number): Partial<Record<GatewayRole, number>> | undefined {
  if (environment.LISTEN_PID === undefined && environment.LISTEN_FDS === undefined) return undefined;
  if (environment.LISTEN_PID !== String(pid) || environment.LISTEN_FDS !== '3') {
    throw new Error('Invalid socket activation descriptors.');
  }
  return Object.fromEntries(GATEWAY_ROLES.map((role, index) => [role, 3 + index]));
}
