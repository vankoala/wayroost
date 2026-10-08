// Paseo settings for "Workers' approvals come to me".
// Paseo 0.9 takes its own agent tools away per provider id, in config.json under
// agents.providers.<id>.paseoTools = { enabled?, disabledTools? }. There is no per-profile
// and no wildcard form, so every provider id gets its own entry, and the roles are
// providers of their own, each based on pi. Plugin-only providers stay uncovered under
// the pinned schema, which requires extends and label for custom providers. Newer Paseo
// schemas accept plugin overrides without those fields; the helper still skips entries
// it cannot validate and reports them as uncovered.
//
// Applying the option is a merge: a provider keeps whatever it already has off, and the
// option only adds to it. What it found and what it wrote are kept as a backup, and undo
// puts back exactly what it found. Everything here works on the agents.providers object
// and returns a new one; nothing is changed in place.
import { isDeepStrictEqual } from 'node:util';

/** With the option on, every provider loses these: answering approvals, and changing modes. */
export const APPROVAL_TOOLS = ['respond_to_permission', 'set_agent_mode', 'update_agent'] as const;
/** Paseo 0.9.2's built-in providers (protocol provider-config.js BUILTIN_PROVIDER_IDS). */
export const BUILTIN_PROVIDER_IDS = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp'] as const;

/**
 * Workers and reviewers have Paseo's agent tools off whatever the option says: no tools,
 * and no Paseo MCP server or token in their config. A lead keeps them, as do the agents
 * you start yourself.
 */
export const ROLE_PROVIDERS = {
  'coder-lead': { label: 'Coder lead', description: 'Plans the work and starts workers', paseoTools: true },
  'coder-worker': { label: 'Coder worker', description: "Does one task, without Paseo's agent tools", paseoTools: false },
  reviewer: { label: 'Reviewer', description: "Reviews a change, without Paseo's agent tools", paseoTools: false },
} as const;
export type RoleProviderId = keyof typeof ROLE_PROVIDERS;

export interface PaseoToolsPolicy {
  [key: string]: unknown;
  enabled?: boolean;
  disabledTools?: string[];
}
/** One agents.providers entry. Only paseoTools is ours; every other key stays as it is. */
export interface ProviderEntry {
  [key: string]: unknown;
  paseoTools?: PaseoToolsPolicy;
}
export type Providers = Record<string, ProviderEntry>;
/** What the option found for one provider id, and what it wrote there. */
export interface ProviderBackup {
  /** "added" when the provider had no entry and the option made one (a built-in). */
  entry: 'existing' | 'added';
  /** The entry's paseoTools before the option; absent when it had none. */
  before?: PaseoToolsPolicy;
  /** The paseoTools the option wrote. */
  applied: PaseoToolsPolicy;
}
/** Per provider id. Wayroost keeps it with its own settings until the option goes off. */
export type SafetyBackup = Record<string, ProviderBackup>;

/**
 * `record[id]` when it is the record's own, else undefined. "constructor" is a valid provider
 * id, and every object inherits a constructor: a plain lookup would take that for an entry.
 */
function own<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/** `entry` with its paseoTools replaced where it was (or dropped when `tools` is undefined). */
function withPaseoTools(entry: ProviderEntry, tools: PaseoToolsPolicy | undefined): ProviderEntry {
  if (!('paseoTools' in entry)) return tools ? { ...entry, paseoTools: tools } : { ...entry };
  return Object.fromEntries(
    Object.entries(entry).flatMap(([key, value]): [string, unknown][] => (key !== 'paseoTools' ? [[key, value]] : tools ? [[key, tools]] : [])),
  );
}

/** `now` without the tools the option added on top of `before`; everything else in it stays. */
function withoutOptionTools(now: PaseoToolsPolicy | undefined, before: PaseoToolsPolicy | undefined): PaseoToolsPolicy | undefined {
  if (!now) return undefined;
  const added = new Set<string>(APPROVAL_TOOLS.filter((tool) => !before?.disabledTools?.includes(tool)));
  const disabledTools = (now.disabledTools ?? []).filter((tool) => !added.has(tool));
  const rest = { ...now };
  delete rest.disabledTools;
  if (disabledTools.length > 0 || before?.disabledTools) return { ...now, disabledTools };
  return Object.keys(rest).length > 0 || before ? rest : undefined;
}

/** Adds the role providers that aren't configured yet, and turns Paseo's tools off for workers and reviewers. */
export function withRoleProviders(providers: Providers): Providers {
  const next = { ...providers };
  for (const [id, role] of Object.entries(ROLE_PROVIDERS)) {
    const entry: ProviderEntry = { extends: 'pi', label: role.label, description: role.description, ...providers[id] };
    next[id] = role.paseoTools ? entry : withPaseoTools(entry, { ...entry.paseoTools, enabled: false });
  }
  return next;
}

/**
 * Option on: every built-in and every configured provider loses the approval tools, on top
 * of what it already has off. Re-apply whenever providers are added, passing the backup the
 * last apply returned: ids already in it keep what was saved before the option first ran.
 */
export function applyApprovalsToMe(providers: Providers, previous: SafetyBackup = {}): { providers: Providers; backup: SafetyBackup } {
  const next = { ...providers };
  const backup: SafetyBackup = {};
  for (const id of new Set([...BUILTIN_PROVIDER_IDS, ...Object.keys(providers)])) {
    const entry = own(providers, id);
    const tools = entry?.paseoTools;
    const applied: PaseoToolsPolicy = { ...tools, disabledTools: [...new Set([...(tools?.disabledTools ?? []), ...APPROVAL_TOOLS])] };
    next[id] = withPaseoTools(entry ?? {}, applied);
    // An id whose entry was removed since the last apply starts over. One whose limits were
    // changed since keeps that change: it is what the provider has off without the option.
    const saved = entry ? own(previous, id) : undefined;
    const before = !saved ? tools : isDeepStrictEqual(tools, saved.applied) ? saved.before : withoutOptionTools(tools, saved.before);
    backup[id] = {
      entry: saved?.entry ?? (entry ? 'existing' : 'added'),
      ...(before ? { before: structuredClone(before) } : {}),
      applied: structuredClone(applied),
    };
  }
  return { providers: next, backup };
}

/**
 * Option off: each provider gets back exactly the paseoTools it had before the option, and
 * entries the option added go. If a provider's limits were changed while the option was on,
 * only the tools the option added come out, so that change stays.
 */
export function undoApprovalsToMe(providers: Providers, backup: SafetyBackup): Providers {
  const next = { ...providers };
  for (const [id, saved] of Object.entries(backup)) {
    const entry = own(providers, id);
    if (!entry) continue; // removed since: nothing to put back
    const now = entry.paseoTools;
    const tools = isDeepStrictEqual(now, saved.applied) ? saved.before : withoutOptionTools(now, saved.before);
    const restored = withPaseoTools(entry, tools && structuredClone(tools));
    if (saved.entry === 'added' && Object.keys(restored).length === 0) delete next[id];
    else next[id] = restored;
  }
  return next;
}
