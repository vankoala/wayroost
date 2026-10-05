// Fallback chains. Every entry must name a provider Hermes actually has an entry
// for, and while Hermes runs on roles one delegation fallback must stay direct:
// that is the way round a gateway that is down.
import { ROLE_PROVIDERS } from '../../../shared/gateway.js';
import { providerIdSchema, modelIdSchema } from '../../../shared/settings-ops.js';
import { consumerRecord } from './common.js';
import type { Check } from './engine.js';

const ROLE_NAMES = Object.values(ROLE_PROVIDERS) as string[];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The provider names a chain entry holds, and the chain's own key name. */
function chainProviders(document: Record<string, unknown>, path: readonly string[]): { providers: string[]; malformed: number } {
  let current: unknown = document;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { providers: [], malformed: 0 };
    current = (current as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(current)) return { providers: [], malformed: 1 };
  const valid = current.filter(entry => isRecord(entry) && providerIdSchema.safeParse(entry.provider).success
    && (entry.model === undefined || modelIdSchema.safeParse(entry.model).success));
  return { providers: valid.map(entry => (entry as Record<string, unknown>).provider as string), malformed: current.length - valid.length };
}

const noProviders = (state: Record<string, unknown>): string[] =>
  isRecord(state.providers) ? Object.keys(state.providers) : [];

export const fallbacksChecks: readonly Check[] = [
  {
    id: 'fallbacks.providers',
    requires: ['hermes.models'],
    unknown: "Hermes' fallback chains could not be read, so their providers were not checked.",
    run: context => {
      const document = context.view('hermes.models').document;
      const known = noProviders(document);
      const chains: { name: string; providers: string[]; malformed: number }[] = [
        { name: 'delegation.fallback_providers', ...chainProviders(document, ['delegation', 'fallback_providers']) },
        { name: 'fallback_providers', ...chainProviders(document, ['fallback_providers']) },
      ];
      const missing = chains.flatMap(chain => [...Array.from({ length: chain.malformed }, () => chain.name), ...chain.providers
        .filter(provider => provider !== '' && !known.includes(provider))
        .map(() => chain.name)]);
      if (!missing.length) {
        const entries = chains.reduce((total, chain) => total + chain.providers.length, 0);
        return { state: 'ok', sentence: 'Every fallback entry names a provider Hermes has.', details: [`${entries} fallback entries`] };
      }
      return {
        state: 'fail',
        sentence: `${new Set(missing).size} fallback chain${new Set(missing).size === 1 ? ' has' : 's have'} an invalid entry or a provider Hermes has no entry for, so that step is skipped.`,
        details: [...new Set(missing)].slice(0, 12),
      };
    },
  },
  {
    id: 'fallbacks.direct-delegation',
    requires: ['hermes.models', 'gateway.state'],
    unknown: "Hermes' delegation fallbacks could not be read, so the direct one was not checked.",
    run: context => {
      const moved = consumerRecord(context.view('gateway.state').document, 'hermes', 'hermes-config');
      if (!moved?.moved) return { state: 'ok', sentence: 'Delegation is not on roles, so its fallbacks already go direct.' };
      const { providers } = chainProviders(context.view('hermes.models').document, ['delegation', 'fallback_providers']);
      if (providers.some(provider => provider !== '' && !ROLE_NAMES.includes(provider))) {
        return { state: 'ok', sentence: 'One delegation fallback goes straight to a provider, so delegation has a way round the gateway.',
          details: ['delegation.fallback_providers'] };
      }
      return {
        state: 'warn',
        sentence: 'Every delegation fallback is a role address, so a gateway that is down leaves delegation nowhere to go.',
        details: ['delegation.fallback_providers'],
      };
    },
  },
];
