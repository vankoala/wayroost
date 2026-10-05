// pi's catalog and default: the role entries a move added, in the order consumers
// resolve them, and what each entry promises. Static entries are written to match a
// role's contract, never one backend, so the contract is what gets compared.
import { settingValuesEqual } from '../../../shared/settings.js';
import { GATEWAY_ROLES, ROLE_PROVIDERS, roleContractSchema, type GatewayRole } from '../../../shared/gateway.js';
import { REASONING_EFFORTS } from '../../../shared/settings-ops.js';
import { consumerRecord, keyName } from './common.js';
import type { Check, CheckContext } from './engine.js';

const MAIN_ROLE: GatewayRole = GATEWAY_ROLES[0]!;
const MAIN_PROVIDER = ROLE_PROVIDERS[MAIN_ROLE];
const ROLE_NAMES = Object.values(ROLE_PROVIDERS) as string[];

const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The provider names in pi's catalog, in the file's own order. */
function providerOrder(context: CheckContext): string[] | undefined {
  const view = context.view('pi.models');
  const ordered = view.order['providers'];
  if (ordered?.length) return [...ordered];
  return Object.keys(record(view.document.providers) ?? {});
}

const reapply = (target: string) => ({ operation: 'gateway.reapply-intended', params: { consumer: 'pi' as const, target } });

export const piChecks: readonly Check[] = [
  {
    id: 'pi.role-order',
    requires: ['pi.models', 'gateway.state'],
    unknown: "pi's catalog could not be read, so the order of its role entries was not checked.",
    run: context => {
      const moved = consumerRecord(context.view('gateway.state').document, 'pi', 'pi-models');
      const order = providerOrder(context);
      if (!order) return { state: 'unknown', sentence: "The order of the entries in pi's catalog could not be read." };
      const onRoles = order.filter(name => ROLE_NAMES.includes(name)).length;
      if (!moved?.moved) {
        if (onRoles) {
          return {
            state: 'warn',
            sentence: `pi's catalog holds ${onRoles} role ${onRoles === 1 ? 'entry' : 'entries'} although pi is not recorded as moved.`,
            details: ['providers'],
          };
        }
        return { state: 'ok', sentence: "pi's catalog has no role entries to order." };
      }
      if (order[0] === MAIN_PROVIDER) {
        return {
          state: 'ok',
          sentence: 'The main role is first in pi\'s catalog, so that is what a new agent resolves by default.',
          details: [`${order.length} providers`],
        };
      }
      return {
        state: 'fail',
        sentence: 'The main role is not first in pi\'s catalog, so new agents start somewhere else.',
        details: ['providers', keyName(['providers', MAIN_PROVIDER])],
        fix: reapply('pi-models'),
      };
    },
  },
  {
    id: 'pi.default',
    requires: ['pi.settings', 'gateway.state'],
    unknown: "pi's settings could not be read, so its default was not checked.",
    run: context => {
      const moved = consumerRecord(context.view('gateway.state').document, 'pi', 'pi-settings');
      if (!moved?.moved) return { state: 'ok', sentence: 'pi is not moved onto roles; its own default applies.' };
      const provider = text(context.value('pi.settings', ['defaultProvider']).value);
      const model = text(context.value('pi.settings', ['defaultModel']).value);
      if (provider === MAIN_PROVIDER && model === MAIN_ROLE) return { state: 'ok', sentence: "pi's default is the main role." };
      return {
        state: 'fail',
        sentence: "pi's default is not the main role it was moved onto.",
        details: [keyName(['defaultProvider']), keyName(['defaultModel'])],
        fix: reapply('pi-settings'),
      };
    },
  },
  {
    id: 'pi.entries',
    requires: ['pi.models', 'gateway.role-map'],
    unknown: "pi's catalog or the role map could not be read, so the role entries were not compared to their contracts.",
    run: context => {
      const catalog = record(context.view('pi.models').document.providers) ?? {};
      const contracts = record(context.view('gateway.role-map').document.contracts);
      if (!contracts || GATEWAY_ROLES.some(role => !roleContractSchema.safeParse(contracts[role]).success)) {
        return { state: 'unknown', sentence: 'Complete role contracts could not be read, so the static entries were not compared.' };
      }
      const wrong: string[] = [];
      for (const role of GATEWAY_ROLES) {
        const contract = record(contracts[role]);
        if (!contract) continue;
        const entry = record(catalog[ROLE_PROVIDERS[role]]);
        if (!entry) {
          wrong.push(`${role}: no entry`);
          continue;
        }
        const models = Array.isArray(entry.models) ? entry.models : [];
        const model = models.map(record).find(candidate => candidate?.id === role);
        if (!model) {
          wrong.push(`${role}: no model`);
          continue;
        }
        const problems: string[] = [];
        const advertised = count(contract.advertisedContext);
        const cap = count(contract.maxOutputTokens);
        if (advertised !== undefined && count(model.contextWindow) !== advertised) problems.push('window');
        if (cap !== undefined && count(model.maxTokens) !== cap) problems.push('output cap');
        if (!Array.isArray(model.input) || names(model.input).length !== model.input.length
          || !settingValuesEqual(names(contract.input).sort(), names(model.input).sort())) problems.push('input types');
        const thinking = flag(contract.thinkingLevels);
        if (thinking !== undefined && flag(model.reasoning) !== thinking) problems.push('thinking levels');
        const address = context.deployment.roleAddresses?.[role];
        if (!address) return { state: 'unknown', sentence: 'This PC states no address for a role, so its static entry could not be compared.' };
        if (text(entry.baseUrl) !== address) problems.push('address');
        const levels = record(model.thinkingLevelMap);
        if (thinking && (!levels || !['minimal', 'low', 'medium', 'high'].every(level => text(levels[level]))
          || Object.values(levels).some(value => !(REASONING_EFFORTS as readonly unknown[]).includes(value) || value === ''))) problems.push('thinking mapping');
        if (problems.length) wrong.push(`${role}: ${problems.join(', ')}`);
      }
      if (wrong.length) {
        return {
          state: 'fail',
          sentence: `The role entries in pi's catalog do not match their contracts, for ${wrong.length} role${wrong.length === 1 ? '' : 's'}.`,
          details: wrong.slice(0, 12),
          fix: reapply('pi-models'),
        };
      }
      return { state: 'ok', sentence: "The role entries in pi's catalog match their contracts.", details: [...GATEWAY_ROLES] };
    },
  },
];
