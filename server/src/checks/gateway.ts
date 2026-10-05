// The model gateway: is it answering, does its socket unit still hold the role
// ports, and does each role serve the backend the live profile's row gives? A
// socket unit that failed closes every role port until it is restarted, and a
// backend port someone else holds answers nothing to the gateway.
import { GATEWAY_ROLES, type GatewayRole } from '../../../shared/gateway.js';
import type { SettingValue } from '../../../shared/settings.js';
import type { Check, CheckContext } from './engine.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const backendId = (value: SettingValue | undefined): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/** The port a role is served on; undefined when this PC states no address for it. */
function rolePort(context: CheckContext, role: GatewayRole): number | undefined {
  const address = context.deployment.roleAddresses?.[role];
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || undefined;
  } catch {
    return undefined;
  }
}

/** The role map: what serves now, and what the live profile's row says should. */
function roleMap(context: CheckContext): {
  now: Record<string, SettingValue | undefined>;
  /** What the live profile's row maps, and the manual change on top of it. */
  expected: (role: GatewayRole) => string | null | undefined;
  manual: boolean;
} | undefined {
  const map = context.view('gateway.role-map').document;
  if (!isRecord(map.roles)) return undefined;
  const state = isRecord(context.view('gateway.state').document.state)
    ? context.view('gateway.state').document.state as Record<string, unknown> : {};
  const profile = typeof state.profile === 'string' ? state.profile : undefined;
  const engine = typeof state.engine === 'string' ? state.engine : undefined;
  const row = isRecord(map.profiles) && profile && engine ? map.profiles[`${profile}/${engine}`] : undefined;
  const overrides = isRecord(state.overrides) ? state.overrides : undefined;
  return {
    now: map.roles as Record<string, SettingValue | undefined>,
    manual: overrides !== undefined && GATEWAY_ROLES.some(role => overrides[role] !== undefined),
    expected: role => {
      const override = overrides?.[role];
      if (isRecord(override) && typeof override.backend === 'string') return override.backend;
      if (!isRecord(row)) return undefined;
      return row[role] === null ? null : backendId(row[role] as SettingValue);
    },
  };
}

/** A backend's loopback port, from the map's own entry for it. */
function backendPort(context: CheckContext, backend: string | null | undefined): number | undefined {
  if (!backend) return undefined;
  const backends = context.view('gateway.role-map').document.backends;
  const entry = isRecord(backends) ? backends[backend] : undefined;
  if (!isRecord(entry) || typeof entry.baseUrl !== 'string') return undefined;
  try {
    const url = new URL(entry.baseUrl);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || undefined;
  } catch {
    return undefined;
  }
}

function roleCheck(role: GatewayRole): Check {
  return {
    id: `gateway.backend.${role}`,
    requires: ['gateway', 'gateway.role-map', 'gateway.state'],
    unknown: `The gateway, the role map or the gateway state could not be read, so the ${role} role was not compared.`,
    run: context => {
      const map = roleMap(context);
      if (!map) return { state: 'unknown', sentence: `The role map holds no roles, so the ${role} role was not compared.` };
      const status = context.gateway().status;
      if (!status?.ok) return { state: 'unknown', sentence: `The gateway's private status could not be read, so the ${role} backend was not compared.` };
      const live = status.value.roles[role].backend;
      const health = status.value.roles[role].health;
      const port = status.value.roles[role].backendPort ?? backendPort(context, live);
      const named = (what: string) => port === undefined ? [`${role} role`] : [`${role} role port ${port}`, what];
      if (health === 'owner_mismatch') {
        return {
          state: 'fail',
          sentence: `Someone other than the expected owner holds the port behind the ${role} role, so its requests go nowhere.`,
          details: named('expected owner checked'),
        };
      }
      if (health === 'unknown') return { state: 'unknown', sentence: `The ${role} backend's ownership and health could not be checked.` };
      const expected = map.expected(role);
      if (expected === undefined) {
        return { state: 'ok', sentence: `No model profile is recorded as up, so nothing says what the ${role} role should serve.`, details: [`${role} role`] };
      }
      if (live === null) {
        if (expected === null) {
          return { state: 'ok', sentence: `The ${role} role is unmapped, as its profile row leaves it; its connections are refused, as a stopped engine's are.` };
        }
        return {
          state: 'fail',
          sentence: `The ${role} role serves no backend although the live profile maps one.`,
          details: [`${role} role`, 'gateway-role-map'],
          fix: { operation: 'gateway.point', params: { role, backend: expected } },
        };
      }
      if (live !== expected) {
        return {
          state: 'warn',
          sentence: `The ${role} role serves a backend other than the one the live profile's row gives.`,
          details: [`${role} role`, ...(expected === null ? ['its row leaves it unmapped'] : []),
            ...(map.manual ? ['a manual change lasts until the next switch'] : [])],
          ...(expected === null ? {} : { fix: { operation: 'gateway.point' as const, params: { role, backend: expected } } }),
        };
      }
      if (health === 'down') {
        return {
          state: 'warn',
          sentence: `The ${role} role's backend is not answering, so consumers get a connection error from it.`,
          details: named('as from a stopped engine'),
        };
      }
      return {
        state: 'ok',
        sentence: `The ${role} role serves the backend its profile row gives.`,
        details: [`${role} role`],
      };
    },
  };
}

export const gatewayChecks: readonly Check[] = [
  {
    id: 'gateway.health',
    requires: ['gateway'],
    unknown: 'The gateway could not be reached, so its health answer is unknown.',
    run: context => {
      const gateway = context.gateway();
      const silent = GATEWAY_ROLES.filter(role => !gateway.healthz[role]);
      if (!silent.length) {
        return {
          state: 'ok',
          sentence: 'The gateway answers its health check on every role address.',
          details: [...GATEWAY_ROLES.map(role => `${role} role`), ...(gateway.draining ? ['a drain is holding new requests'] : [])],
        };
      }
      return {
        state: 'fail',
        sentence: `The gateway does not answer its health check on ${silent.length} of ${GATEWAY_ROLES.length} role addresses.`,
        details: silent.map(role => `${role} role`),
        fix: { restart: { component: 'gateway', when: 'now' } },
      };
    },
  },
  {
    id: 'gateway.socket-unit',
    requires: ['gateway'],
    unknown: "The gateway's socket unit could not be read, so the role ports were not checked.",
    run: context => {
      const gateway = context.gateway();
      const ports = GATEWAY_ROLES.map(role => rolePort(context, role));
      if (gateway.socketUnit === null) {
        return { state: 'unknown', sentence: 'This PC cannot say what state the socket unit that holds the role ports is in.' };
      }
      if (ports.some(port => port === undefined)) {
        return { state: 'unknown', sentence: 'This PC states no address for one of the roles, so the ports it holds were not checked.' };
      }
      if (gateway.socketUnit === 'failed') {
        return {
          state: 'fail',
          priority: 'high',
          sentence: 'The socket unit that holds the role ports has failed: none of them can be connected to until it is restarted.',
          details: ['reset-failed on both units', ...ports.map(port => `port ${port}`)],
          fix: { operation: 'gateway.socket-recover', params: {} },
        };
      }
      if (gateway.listeningPorts === null) return { state: 'unknown', sentence: 'The kernel socket table could not be read, so the held ports are unknown.' };
      const listeners = gateway.listeners;
      if (!listeners?.ok) return { state: 'unknown', sentence: 'The role listeners could not be matched to their socket unit, so their ownership is unknown.' };
      const listeningPorts = gateway.listeningPorts;
      const missing = GATEWAY_ROLES.filter(role => !listeningPorts.includes(rolePort(context, role)!)
        || listeners.value.roles[role].state !== 'held'
        || new URL(listeners.value.roles[role].address).origin !== new URL(context.deployment.roleAddresses![role]!).origin);
      if (gateway.socketUnit !== 'active' || missing.length) {
        return {
          state: 'fail',
          sentence: missing.length
            ? `Only ${GATEWAY_ROLES.length - missing.length} of the ${GATEWAY_ROLES.length} role ports are being held.`
            : `The socket unit that holds the role ports is not active; it reads ${gateway.socketUnit}.`,
          details: [...(missing.length ? missing.map(role => `${role} role`) : ['socket unit not active']), ...ports.map(port => `port ${port}`)],
          fix: { operation: 'gateway.socket-recover', params: {} },
        };
      }
      return { state: 'ok', sentence: 'The socket unit is active and holds every role port.', details: ports.map(port => `port ${port}`) };
    },
  },
  ...GATEWAY_ROLES.map(roleCheck),
];
