// Who may make which settings change, from where. Three levels: anywhere (any
// paired device), confirm (a phone repeats the request with a one-time code
// bound to it), and PC only (the paired desktop app, arriving on the server's
// local listener, which the tunnel never targets). Tighten at the lower level,
// loosen at the higher one. These checks stop phones, stale pages and remote
// devices; they don't stop a program running as you on this PC.
import type { DeviceScope } from './protocol.js';
import { LEGACY_POLICY_ROUTES, SETTINGS_ROUTES, SETTINGS_ROUTE_PREFIX, type SettingsErrorCode, type SettingsLevel } from './settings.js';

export { SETTINGS_LEVELS, type SettingsLevel } from './settings.js';

const RANK: Readonly<Record<SettingsLevel, number>> = { anywhere: 0, confirm: 1, 'pc-only': 2 };
export const stricterLevel = (a: SettingsLevel, b: SettingsLevel): SettingsLevel => RANK[a] >= RANK[b] ? a : b;

/** A confirm code is good for this long, for one request from one device. */
export const CONFIRM_TTL_MS = 60_000;

/**
 * What a confirm code is bound to: the operation, a hash of its parameters, the
 * target file's hash when it was issued, and the device it was issued to.
 */
export interface ConfirmBinding {
  operation: string;
  paramsSha256: string;
  targetSha256: string | null;
  deviceId: string;
}

/**
 * A level that may depend on one parameter: `values` maps that parameter's
 * value (booleans as "true" and "false") to a level. A value not listed takes
 * the strictest level.
 */
export type LevelRule =
  | { readonly fixed: SettingsLevel }
  | { readonly byParam: string; readonly values: Readonly<Record<string, SettingsLevel>> };

export function levelFor(rule: LevelRule, params: Readonly<Record<string, unknown>>): SettingsLevel {
  if ('fixed' in rule) return rule.fixed;
  const value = params[rule.byParam];
  const key = typeof value === 'boolean' || typeof value === 'string' ? String(value) : undefined;
  return key !== undefined && Object.hasOwn(rule.values, key) ? rule.values[key]! : 'pc-only';
}

/** The strictest level a parameter-dependent rule can ask for. */
export function strictestLevel(rule: LevelRule): SettingsLevel {
  if ('fixed' in rule) return rule.fixed;
  return Object.values(rule.values).reduce<SettingsLevel>(stricterLevel, 'anywhere');
}

/** Which listener a request arrived on: the main one (the tunnel's), or the PC-only local one. */
export type SettingsListener = 'main' | 'local';

export interface SettingsRequestContext {
  role: 'primary' | 'shadow';
  /** The live paired device's scopes; empty when there's no device. */
  scopes: readonly DeviceScope[];
  listener: SettingsListener;
  /** PC-only rows can be written: the local listener is configured and confirmed to work on this PC. */
  pcOnlyWrites: boolean;
  /** The request carries a valid confirm code bound to exactly it. */
  confirmed: boolean;
}

export type LevelRefusal = Extract<SettingsErrorCode, 'not_permitted' | 'shadow_read_only' | 'confirm_required' | 'pc_only' | 'pc_only_read_only'>;
export type LevelDecision = { allowed: true } | { allowed: false; code: LevelRefusal };

/** A view that may contain literal secrets is read only through the confirmed local desktop listener. */
export function decideRead(context: Pick<SettingsRequestContext, 'scopes'> & Partial<Pick<SettingsRequestContext, 'listener' | 'pcOnlyWrites'>>,
  level: SettingsLevel = 'anywhere'): LevelDecision {
  if (!context.scopes.includes('settings')) return { allowed: false, code: 'not_permitted' };
  if (level !== 'pc-only') return { allowed: true };
  if (!context.pcOnlyWrites) return { allowed: false, code: 'pc_only_read_only' };
  return context.scopes.includes('pc-settings') && context.listener === 'local' ? { allowed: true } : { allowed: false, code: 'pc_only' };
}

/**
 * Whether a change at this level is allowed for this request. A device with
 * pc-settings (the desktop app) needs no confirm code, as with power actions;
 * PC-only also needs the local listener, and stays read-only until it's confirmed.
 */
export function decideChange(level: SettingsLevel, context: SettingsRequestContext): LevelDecision {
  if (context.role === 'shadow') return { allowed: false, code: 'shadow_read_only' };
  if (!context.scopes.includes('settings')) return { allowed: false, code: 'not_permitted' };
  const desktop = context.scopes.includes('pc-settings');
  switch (level) {
    case 'anywhere':
      return { allowed: true };
    case 'confirm':
      return desktop || context.confirmed ? { allowed: true } : { allowed: false, code: 'confirm_required' };
    case 'pc-only':
      if (!context.pcOnlyWrites) return { allowed: false, code: 'pc_only_read_only' };
      return desktop && context.listener === 'local' ? { allowed: true } : { allowed: false, code: 'pc_only' };
  }
}

/** How a page shows a row at this level: editable, editable with the confirm step, or read-only. */
export function rowAccess(level: SettingsLevel, context: Omit<SettingsRequestContext, 'confirmed'>): 'editable' | 'confirm' | 'read-only' {
  const decision = decideChange(level, { ...context, confirmed: false });
  return decision.allowed ? 'editable' : decision.code === 'confirm_required' ? 'confirm' : 'read-only';
}

/**
 * Every settings route, with what it needs. `operation`: the level of the
 * catalogue operation in the body (Checks' Fix included). `change`: the
 * undo level of the recorded change's operation. Parameter rules cover earlier switches.
 */
export interface SettingsRoutePolicy {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** As the router matches it, parameters included. */
  route: string;
  level: SettingsLevel | LevelRule | 'operation' | 'change';
  write: boolean;
}

export const SETTINGS_ROUTE_POLICY: readonly SettingsRoutePolicy[] = [
  { method: 'GET', route: SETTINGS_ROUTES.section, level: 'anywhere', write: false },
  { method: 'GET', route: SETTINGS_ROUTES.changes, level: 'anywhere', write: false },
  { method: 'GET', route: SETTINGS_ROUTES.checks, level: 'anywhere', write: false },
  { method: 'GET', route: SETTINGS_ROUTES.usage, level: 'anywhere', write: false },
  { method: 'POST', route: SETTINGS_ROUTES.apply, level: 'operation', write: true },
  { method: 'POST', route: SETTINGS_ROUTES.undo, level: 'change', write: true },
  { method: 'POST', route: SETTINGS_ROUTES.restart, level: { byParam: 'when', values: { idle: 'anywhere', now: 'confirm' } }, write: true },
  { method: 'GET', route: SETTINGS_ROUTES.restartRun, level: 'anywhere', write: false },
  { method: 'PUT', route: SETTINGS_ROUTES.credential, level: 'pc-only', write: true },
  { method: 'DELETE', route: SETTINGS_ROUTES.credential, level: 'pc-only', write: true },
  { method: 'POST', route: SETTINGS_ROUTES.credentialTest, level: 'pc-only', write: true },
  { method: 'GET', route: SETTINGS_ROUTES.notifications, level: 'anywhere', write: false },
  { method: 'PUT', route: SETTINGS_ROUTES.notifications, level: 'anywhere', write: true },
  { method: 'GET', route: SETTINGS_ROUTES.safetyCommands, level: 'anywhere', write: false },
  { method: 'PUT', route: SETTINGS_ROUTES.safetyCommands, level: { byParam: 'enabled', values: { true: 'pc-only', false: 'anywhere' } }, write: true },
  { method: 'GET', route: LEGACY_POLICY_ROUTES.safetyCommands, level: 'anywhere', write: false },
  { method: 'PUT', route: LEGACY_POLICY_ROUTES.safetyCommands, level: { byParam: 'enabled', values: { true: 'pc-only', false: 'anywhere' } }, write: true },
  { method: 'PUT', route: LEGACY_POLICY_ROUTES.cloudAgent, level: 'confirm', write: true },
  { method: 'PUT', route: LEGACY_POLICY_ROUTES.workerApprovals, level: { byParam: 'enabled', values: { true: 'anywhere', false: 'pc-only' } }, write: true },
  { method: 'PUT', route: LEGACY_POLICY_ROUTES.notifications, level: 'anywhere', write: true },
];

/** The router sends matched templates to routePolicy; this guard also recognises actual earlier paths. */
export function isSettingsPolicyRoute(route: string): boolean {
  return route.startsWith(SETTINGS_ROUTE_PREFIX) || Object.values(LEGACY_POLICY_ROUTES).some(template =>
    template === route || (template.endsWith('/:id') && route.startsWith(template.slice(0, -3))));
}

export function routePolicyLevel(policy: SettingsRoutePolicy, params: Readonly<Record<string, unknown>>): SettingsLevel | 'operation' | 'change' {
  return typeof policy.level === 'string' ? policy.level : levelFor(policy.level, params);
}

/** The policy for a matched route, or undefined when it isn't a settings route. */
export function routePolicy(method: string, route: string): SettingsRoutePolicy | undefined {
  return SETTINGS_ROUTE_POLICY.find(policy => policy.method === method && policy.route === route);
}
