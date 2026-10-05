import { join } from 'node:path';
import { z } from 'zod';
import { agentAvailabilitySchema } from '../../../shared/settings-ops.js';
import { GATEWAY_ROLES, gatewayAdminStatusSchema } from '../../../shared/gateway.js';
import { readJsonBounded } from '../hub/safe-read.js';
import type { AppConfig } from '../config.js';
import type { SupervisorApi } from '../supervisor-client.js';
import type { SettingsOptions } from './routes.js';

const loadSchema = z.object({ roleId: z.string().regex(/^[a-z0-9-]+$/), harness: z.enum(['hermes', 'paseo', 'claude', 'codex']),
  words: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(),
  targetWords: z.number().int().positive(), budgetWords: z.number().int().positive().nullable(),
  parts: z.array(z.object({ name: z.string().max(256), words: z.number().int().nonnegative() })).max(512),
});
const measurementsSchema = z.object({ loads: z.array(loadSchema).max(512) });
export function productionSettingsReaders(config: AppConfig, supervisor?: SupervisorApi): Pick<SettingsOptions, 'modelStatus' | 'roleLoads' | 'agentAvailability'> {
  return {
    modelStatus: async () => {
      const result = await supervisor?.configRead?.({ view: 'gateway.status' });
      if (!result?.ok || !result.present) throw new Error('unavailable');
      const status = gatewayAdminStatusSchema.parse(Object.fromEntries(result.values.filter(entry => entry.exists)
        .map(entry => [entry.path[0], entry.exists ? entry.value : undefined])));
      return GATEWAY_ROLES.map(role => ({ role, health: status.roles[role].health, inFlight: status.roles[role].inFlight }));
    },
    roleLoads: async () => {
      const result = await readJsonBounded(config.settings.packBuildFile ?? join(config.stateDir, 'roles-pack-build.json'), { maxBytes: 4 * 1024 * 1024 });
      if ('refused' in result) throw new Error('unavailable');
      const build = measurementsSchema.parse(result.value);
      return build.loads.map(load => {
        const part = (name: string) => load.parts.find(part => part.name === name)?.words ?? 0;
        const shared = part('shared rules'); const dispatch = part('dispatch protocol'); const role = part('role section');
        const skills = load.parts.filter(part => !['shared rules', 'dispatch protocol', 'role section'].includes(part.name)).reduce((total, part) => total + part.words, 0);
        if (shared + dispatch + role + skills !== load.words) throw new Error('unavailable');
        return { role: load.roleId, harness: load.harness, words: load.words, tokens: load.tokens,
          targetWords: load.targetWords, budgetWords: load.budgetWords, parts: { shared, dispatch, role, skills } };
      });
    },
    agentAvailability: async () => {
      const result = await supervisor?.configRead?.({ view: 'wayroost.agents' });
      if (!result?.ok || result.view !== 'wayroost.agents' || !result.present) throw new Error('unavailable');
      const value = result.values.find(entry => entry.exists && entry.path.length === 1 && entry.path[0] === 'agents');
      return agentAvailabilitySchema.parse(value?.exists ? value.value : undefined);
    },
  };
}
