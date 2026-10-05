import { parseArgs } from 'node:util';
import { ROLES, type Role } from './config.js';
import type { GatewayOptions } from './gateway.js';

const LIMITS = {
  'max-request-bytes': 'maxRequestBytes',
  'backend-timeout-ms': 'backendTimeoutMs',
  'idle-timeout-ms': 'idleTimeoutMs',
  'health-timeout-ms': 'healthTimeoutMs',
} as const;

/** Parses the CLI arguments into gateway options; throws on anything unknown or malformed. */
export function parseCliOptions(args: string[]): Omit<GatewayOptions, 'log'> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    config: { type: 'string' }, socket: { type: 'string' }, 'credentials-dir': { type: 'string' }, listen: { type: 'string', multiple: true },
    ...Object.fromEntries(Object.keys(LIMITS).map(name => [name, { type: 'string' as const }])),
  } });
  if (typeof values.config !== 'string' || typeof values.socket !== 'string') throw new Error('Missing arguments.');
  const options: Omit<GatewayOptions, 'log'> = { configFile: values.config, adminSocket: values.socket };
  const credentials = values['credentials-dir'];
  if (credentials !== undefined) {
    if (typeof credentials !== 'string') throw new Error('Invalid credentials directory.');
    options.credentialsDirectory = credentials;
  }
  if (values.listen) {
    const ports: Partial<Record<Role, number>> = {};
    for (const value of values.listen as string[]) {
      const match = /^(main|coder|fast)=(\d+)$/.exec(value);
      if (!match || !ROLES.includes(match[1] as Role) || ports[match[1] as Role] !== undefined) throw new Error('Invalid listener.');
      ports[match[1] as Role] = Number(match[2]);
    }
    options.ports = ports;
  }
  for (const [flag, key] of Object.entries(LIMITS)) {
    const value = values[flag as keyof typeof values];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value)) throw new Error('Invalid limit.');
    options[key] = Number(value);
  }
  return options;
}
