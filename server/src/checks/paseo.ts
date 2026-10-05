// Paseo profiles resolve through their provider's catalog. Existing agents keep
// their pins independently of profiles; switches compare the daemon's effective
// provider state with the file that guards them.
import { ROLE_PROVIDERS } from '../../../shared/gateway.js';
import { PASEO_AGENT_PROVIDERS, PASEO_BUILTIN_PROVIDERS } from '../../../shared/settings-ops.js';
import { decideRead } from '../../../shared/settings-levels.js';
import { entryHash } from './common.js';
import type { Check, CheckContext } from './engine.js';

const ROLE_NAMES = Object.values(ROLE_PROVIDERS) as string[];
const KNOWN_PROVIDERS: readonly string[] = [...new Set([...PASEO_BUILTIN_PROVIDERS, ...PASEO_AGENT_PROVIDERS])];

const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (name: string, context: CheckContext): string => decideRead(context.settingsContext, 'pc-only').allowed ? name : `sha256:${entryHash(name)}`;

function profilesOf(document: Record<string, unknown>): Record<string, unknown>[] {
  const profiles = isRecord(document.daemon) && Array.isArray(document.daemon.agentProfiles) ? document.daemon.agentProfiles : [];
  return profiles.filter(isRecord);
}

/** A profile's model as pi names it: "<provider>/<model>". */
function splitModel(model: string): { provider: string; model: string } | undefined {
  const slash = model.indexOf('/');
  return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : undefined;
}

export const paseoChecks: readonly Check[] = [
  {
    id: 'paseo.profiles',
    requires: ['paseo.agents', 'pi.models'],
    unknown: "Paseo's profiles or pi's catalog could not be read, so profile models were not checked.",
    run: context => {
      const profiles = profilesOf(context.view('paseo.agents').document);
      if (!profiles.length) return { state: 'ok', sentence: 'Paseo has no profiles set.' };
      const catalog = isRecord(context.view('pi.models').document.providers) ? context.view('pi.models').document.providers as Record<string, unknown> : {};
      const unknown: string[] = [];
      for (const profile of profiles) {
        const name = text(profile.id) ?? text(profile.name);
        const model = text(profile.model);
        if (!name) continue;
        const providerId = text(profile.provider);
        if (!providerId || !KNOWN_PROVIDERS.includes(providerId)) { unknown.push(name); continue; }
        if (!model) continue;
        if (providerId !== 'pi') {
          if (!context.paseoRuntime().providers[providerId]?.models.includes(model)) unknown.push(name);
          continue;
        }
        const parts = splitModel(model);
        const provider = parts ? catalog[parts.provider] : undefined;
        const models = isRecord(provider) && Array.isArray(provider.models) ? provider.models : [];
        const served = parts && models.map(entry => isRecord(entry) ? text(entry.id) : undefined).includes(parts.model);
        if (!served) unknown.push(name);
      }
      if (unknown.length) {
        return {
          state: 'fail',
          sentence: `${unknown.length} Paseo profile${unknown.length === 1 ? '' : 's'} name ${unknown.length === 1 ? 'a model' : 'models'} their provider doesn't have.`,
          details: unknown.slice(0, 12).map(name => identity(name, context)),
        };
      }
      return { state: 'ok', sentence: "Every Paseo profile names a valid provider and model.", details: [`${profiles.length} profiles`] };
    },
  },
  {
    id: 'paseo.pinned-agents',
    requires: ['paseoRuntime', 'gateway.state'],
    unknown: "Paseo's existing agents could not be read, so nothing was counted as pinned.",
    run: context => {
      const profiles = context.paseoRuntime().agents;
      if (profiles.some(agent => agent.provider === 'pi' && !text(agent.model))) return {
        state: 'unknown', sentence: 'An existing pi agent does not report its resolved model, so provider pins could not be counted.',
      };
      const onRoles = profiles.filter(profile => {
        const parts = splitModel(text(profile.model) ?? '');
        return profile.provider === 'pi' && parts !== undefined && ROLE_NAMES.includes(parts.provider);
      });
      const direct = profiles.length - onRoles.length;
      const details = [...onRoles.map(profile => identity(text(profile.id) ?? 'agent', context)).slice(0, 10), `${direct} on direct providers`];
      const moved = isRecord(context.view('gateway.state').document.migration);
      if (onRoles.length && !moved) {
        return {
          state: 'warn',
          sentence: `${onRoles.length} Paseo agent${onRoles.length === 1 ? '' : 's'} resolve to role addresses although no consumer is recorded as moved.`,
          details,
        };
      }
      return {
        state: 'ok',
        sentence: `${onRoles.length} Paseo agent${onRoles.length === 1 ? '' : 's'} resolve to role addresses, ${direct} to direct providers.`,
        details,
      };
    },
  },
  {
    id: 'paseo.switch-flags',
    requires: ['paseoRuntime', 'switchFlags'],
    unknown: "The switch file or Paseo's config could not be read, so the provider switches were not compared.",
    run: context => {
      const flags = context.switchFlags();
      const agents = context.paseoRuntime().providers;
      const different = Object.entries(flags).filter(([provider, flag]) => {
        const effective = agents[provider]?.enabled;
        if (effective === undefined) throw new Error('unavailable');
        return flag !== effective;
      }).map(([provider]) => provider);
      if (!Object.keys(flags).length) return { state: 'ok', sentence: 'The switch file holds no provider switches.' };
      if (different.length) {
        return {
          state: 'warn',
          sentence: `${different.length} Paseo provider switch${different.length === 1 ? '' : 'es'} in the file that guards them differ from the effective ones.`,
          details: different.filter(provider => KNOWN_PROVIDERS.includes(provider)).slice(0, 12),
        };
      }
      return { state: 'ok', sentence: 'Every provider switch matches what Paseo runs with.', details: [`${Object.keys(flags).length} switches`] };
    },
  },
];
