// Hermes against the model gateway: the keys a move pointed at roles must name
// their role, and every key Wayroost wrote must still hold the value Wayroost
// wrote. Drift compares values only, and the values it compares are the ones read
// through the consumer's own reader. A file whose content hash moved while every
// value stayed the same is not drift, and a file's modification time is never
// read, so an mtime-only change cannot be drift either.
import { GATEWAY_ROLES, ROLE_PROVIDERS, type MigrationTargetRecord } from '../../../shared/gateway.js';
import { redactedSettingValueSchema, settingValuesEqual, type KeyPath, type SettingValue } from '../../../shared/settings.js';
import { comparisonHeld, consumerRecord, isRoleProvider, keyName, recordedKeys } from './common.js';
import type { Check, CheckContext } from './engine.js';

const HERMES_VIEWS = ['hermes.providers', 'hermes.models', 'hermes.agents', 'hermes.safety'] as const;
const REAPPLY = { operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config' } } as const;
const MAIN_ROLE = GATEWAY_ROLES[0]!;
const FAST_ROLE = GATEWAY_ROLES[2]!;

type Held = { exists: boolean; value?: SettingValue };

const sameHeld = (a: Held, b: Held): boolean => settingValuesEqual(comparisonHeld(a), comparisonHeld(b));

/** The value a moved key must hold, from its path; undefined when roles say nothing about it. */
function roleValueFor(path: KeyPath, address: string): SettingValue | undefined {
  const [group, field, third] = path;
  if (group === 'model' && field === 'provider') return ROLE_PROVIDERS.main;
  if (group === 'model' && field === 'default') return MAIN_ROLE;
  if (group === 'model' && field === 'base_url') return address;
  if (group === 'delegation' && field === 'provider') return ROLE_PROVIDERS.main;
  if (group === 'delegation' && field === 'model') return MAIN_ROLE;
  if (group === 'auxiliary' && third === 'provider') return ROLE_PROVIDERS.fast;
  if (group === 'auxiliary' && third === 'model') return FAST_ROLE;
  return undefined;
}

/** Hermes' prompt keys a move sets explicitly, so no prompt block changes silently. */
const EXPLICIT_KEYS: readonly KeyPath[] = [['agent', 'tool_use_enforcement'], ['agent', 'execution_guidance'], ['model', 'reasoning_echo']];

/** An empty personality is Hermes for no personality: a recorded absence and a written empty string agree. */
function asHeld(path: KeyPath, held: Held): Held {
  return path.length === 2 && path[0] === 'display' && path[1] === 'personality' && held.exists && sameHeld(held, { exists: true, value: '' })
    ? { exists: false } : held;
}

function lookUp(document: unknown, path: KeyPath): Held {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof segment === 'object' || current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? { exists: false } : { exists: true, value: current as SettingValue };
}

interface Drift {
  moved: boolean;
  /** Keys whose live value isn't the value Wayroost last wrote for them. */
  drifted: KeyPath[];
  /** Drifted keys back at the value they held before that change: one stale page's save. */
  stalePage: KeyPath[];
}

function latestKeys(context: CheckContext, record: MigrationTargetRecord | undefined) {
  const intended = new Map(recordedKeys(record).map(key => [JSON.stringify(key.path), key]));
  const refusal = context.refusal('intended');
  if (refusal && refusal.failure !== 'not_configured') throw new Error('unavailable');
  if (!refusal) for (const key of context.intended()) {
    const movedAt = record?.movedAt ? Date.parse(record.movedAt) : 0;
    const name = JSON.stringify(key.path);
    if (intended.has(name) && key.at !== undefined && key.at < movedAt) continue;
    intended.set(name, { ...key, kind: 'recorded' });
  }
  return intended;
}

function liveHeld(context: CheckContext, document: unknown, path: KeyPath): Held {
  if (path.length === 2 && path[0] === 'providers') return context.value('hermes.providers', path);
  return asHeld(path, lookUp(document, path));
}

function matchesHeld(path: KeyPath, live: Held, intended: Held): boolean {
  if (path.length === 2 && path[0] === 'providers' && live.exists && !redactedSettingValueSchema.safeParse(live.value).success) throw new Error('unavailable');
  return sameHeld(live, asHeld(path, intended));
}

function driftOf(context: CheckContext): Drift {
  const record = consumerRecord(context.view('gateway.state').document, 'hermes', 'hermes-config');
  const intended = latestKeys(context, record);
  if (!intended.size) return { moved: false, drifted: [], stalePage: [] };
  const document = context.files(HERMES_VIEWS);
  const drifted: KeyPath[] = [];
  const stalePage: KeyPath[] = [];
  for (const key of intended.values()) {
    if (key.path[0] === 'command_allowlist') continue;
    const live = liveHeld(context, document, key.path);
    if (matchesHeld(key.path, live, key.intended)) continue;
    drifted.push(key.path);
    if (matchesHeld(key.path, live, key.before)) stalePage.push(key.path);
  }
  return { moved: true, drifted, stalePage };
}

const driftFix = (context: CheckContext, paths?: readonly KeyPath[]) => {
  if (!context.refusal('intended')) {
    const movedAt = Date.parse(consumerRecord(context.view('gateway.state').document, 'hermes', 'hermes-config')?.movedAt ?? '') || 0;
    const candidates = context.intended().filter(key => (key.at ?? 0) >= movedAt
      && paths?.some(path => settingValuesEqual([...path], [...key.path])));
    const key = candidates.find(key => key.intentId);
    if (key) return { operation: 'gateway.reapply-intended', params: { consumer: 'hermes', target: 'hermes-config', intentId: key.intentId } };
    if (candidates.length) return undefined;
  }
  const record = consumerRecord(context.view('gateway.state').document, 'hermes', 'hermes-config');
  if (!record?.moved || record.keys.some(key => key.path[0] === 'command_allowlist')) return undefined;
  const latest = latestKeys(context, record);
  // A whole migration reapply is safe only if every key still has that intent.
  return recordedKeys(record).every(key => sameHeld(key.intended, latest.get(JSON.stringify(key.path))!.intended)) ? REAPPLY : undefined;
};

const keys = (count: number): string => `${count} key${count === 1 ? '' : 's'}`;

export const hermesRoleChecks: readonly Check[] = [
  {
    id: 'hermes.role-addresses',
    requires: ['hermes.models', 'gateway.state'],
    unknown: "Hermes' settings or the gateway's migration record could not be read, so its role addresses were not compared.",
    run: context => {
      const record = consumerRecord(context.view('gateway.state').document, 'hermes', 'hermes-config');
      const provider = context.value('hermes.models', ['model', 'provider']);
      if (!record?.moved) {
        if (isRoleProvider(provider.value)) {
          return {
            state: 'warn',
            sentence: 'Hermes points at role addresses although it is not recorded as moved, so nothing keeps those keys in place.',
            details: [keyName(['model', 'provider']), 'gateway-migration'],
          };
        }
        return { state: 'ok', sentence: 'Hermes is not moved onto roles; its own addresses are what it uses.' };
      }
      const address = context.deployment.roleAddresses?.main;
      if (!address) return { state: 'unknown', sentence: "This PC states no role address, so Hermes' addresses were not compared." };
      const failing: KeyPath[] = [];
      const latest = latestKeys(context, record);
      for (const key of recordedKeys(record)) {
        const expected = roleValueFor(key.path, address);
        if (expected === undefined) continue;
        const live = context.value('hermes.models', key.path);
        const intended = latest.get(JSON.stringify(key.path))!.intended;
        if (!sameHeld(key.intended, intended)) {
          if (!sameHeld(live, intended)) failing.push(key.path);
        } else if (!live.exists || live.value === null || live.value === '' || !settingValuesEqual(live.value, expected)) failing.push(key.path);
      }
      for (const path of EXPLICIT_KEYS) {
        // The move records the keys it sets; a recorded one that went missing is Hermes' own loss.
        if (!record.keys.some(key => settingValuesEqual([...key.path], [...path]))) continue;
        if (!context.value('hermes.models', path).exists && latest.get(JSON.stringify(path))?.intended.exists !== false) failing.push(path);
      }
      if (failing.length) {
        return {
          state: 'fail',
          sentence: `Hermes' role settings are not what the role contracts ask for: ${keys(failing.length)} are wrong or missing.`,
          details: failing.map(keyName).slice(0, 12),
          fix: driftFix(context, failing),
        };
      }
      return { state: 'ok', sentence: "Hermes' models match their roles and later deliberate choices, with the prompt keys the move sets." };
    },
  },
  {
    id: 'hermes.drift',
    requires: [...HERMES_VIEWS, 'gateway.state'],
    unknown: "Hermes' effective settings or the gateway's migration record could not be read, so drift was not compared.",
    run: context => {
      const { moved, drifted, stalePage } = driftOf(context);
      if (!moved) return { state: 'ok', sentence: 'Hermes has no key Wayroost wrote, so nothing can drift.' };
      if (!drifted.length) return { state: 'ok', sentence: 'Every key Wayroost wrote to Hermes still holds the value Wayroost wrote.' };
      const stale = stalePage.length >= 2;
      const remaining = drifted.filter(path => !stale || !stalePage.some(old => settingValuesEqual([...old], [...path])));
      if (!remaining.length) return { state: 'ok', sentence: 'The stale save is reported in its own row.' };
      return {
        state: 'warn',
        sentence: `Hermes runs a different value from the one Wayroost last wrote, for ${keys(remaining.length)}.`,
        details: remaining.map(keyName).slice(0, 12),
        fix: driftFix(context, remaining),
      };
    },
  },
  {
    id: 'hermes.stale-page',
    requires: [...HERMES_VIEWS, 'gateway.state'],
    unknown: "Hermes' effective settings or the gateway's migration record could not be read, so a stale save was not detected.",
    run: context => {
      const { moved, stalePage } = driftOf(context);
      if (!moved) return { state: 'ok', sentence: 'Hermes has no key Wayroost wrote, so nothing of yours can be saved back.' };
      if (stalePage.length < 2) return { state: 'ok', sentence: 'No Hermes key is back at what it held before your change.' };
      return {
        state: 'warn',
        sentence: `A Hermes settings page saved old values: ${keys(stalePage.length)} are back at what they held before your change.`,
        details: stalePage.map(keyName).slice(0, 12),
        fix: driftFix(context, stalePage),
      };
    },
  },
];
