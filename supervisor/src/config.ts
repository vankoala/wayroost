import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SUPERVISOR_DEFAULTS } from '../../shared/supervisor.js';

/** Site-specific adopt-mode commands; the built-in registry holds no paths of its own. */
export const adoptSchema = z.object({
  /** The stack launcher: model switches, stop-model, restart-paseo. */
  launchScript: z.string().startsWith('/').optional(),
  /** The local-model launcher (the coder). */
  coderScript: z.string().startsWith('/').optional(),
  /** Folder holding the keeper hold files (coder-hold, paseo-hold). */
  holdDir: z.string().startsWith('/').optional(),
}).strict();
export type Adopt = z.infer<typeof adoptSchema>;

export const configSchema = z.object({
  development: z.boolean().default(false),
  tls: z.object({ certFile: z.string().startsWith('/'), keyFile: z.string().startsWith('/').optional() }).strict().optional(),
  socket: z.string().startsWith('/').default(SUPERVISOR_DEFAULTS.socket),
  rescueHost: z.literal('127.0.0.1').default('127.0.0.1'),
  rescuePort: z.number().int().min(1).max(65535).default(8880),
  keysFile: z.string().startsWith('/').default('/etc/wayroost/supervisor-keys.json'),
  stateDir: z.string().startsWith('/').default('/var/lib/wayroost-supervisor'),
  registryOverrides: z.string().startsWith('/').default('/etc/wayroost/components.local.json'),
  idleLimitMs: z.number().int().positive().default(1800000),
  pollMs: z.number().int().positive().default(1000),
  /** Pushed busy counts older than this are unknown, not idle. */
  busyStaleMs: z.number().int().positive().default(60000),
  /** Probes remain available, but every action is refused. */
  statusOnly: z.boolean().default(true),
  /** Enable idle restarts only after the production executor has been certified. */
  restartWhenIdleCertified: z.boolean().default(false),
  adopt: adoptSchema.default({}),
}).strict();
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(path = process.env.WAYROOST_SUPERVISOR_CONFIG ?? '/etc/wayroost/supervisor.json'): Promise<Config> {
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
