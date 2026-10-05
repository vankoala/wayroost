import { describe, expect, it } from 'vitest';
import type { DeviceScope } from '../../shared/protocol.js';
import { EARLIER_SETTINGS_ROUTES, LEGACY_POLICY_ROUTES, SETTINGS_ROUTES, SETTINGS_ROUTE_PREFIX, type SettingsLevel } from '../../shared/settings.js';
import {
  SETTINGS_ROUTE_POLICY, decideChange, decideRead, isSettingsPolicyRoute, levelFor, routePolicy, routePolicyLevel, rowAccess, stricterLevel, strictestLevel,
  type SettingsRequestContext,
} from '../../shared/settings-levels.js';
import { OPERATION_IDS, SETTINGS_OPERATIONS, operationLevel, operationSpec, readViewLevel, undoLevel, type OperationId } from '../../shared/settings-ops.js';

// The scopes each kind of device is granted (server/src/devices.ts).
const DESKTOP: DeviceScope[] = ['chats', 'settings', 'pc-settings', 'power', 'devices'];
const PHONE: DeviceScope[] = ['chats', 'settings', 'power-confirm'];

const context = (patch: Partial<SettingsRequestContext> = {}): SettingsRequestContext =>
  ({ role: 'primary', scopes: DESKTOP, listener: 'local', pcOnlyWrites: true, confirmed: false, ...patch });

describe('level rules', () => {
  it('orders the levels and picks the stricter', () => {
    expect(stricterLevel('anywhere', 'confirm')).toBe('confirm');
    expect(stricterLevel('pc-only', 'confirm')).toBe('pc-only');
    expect(stricterLevel('anywhere', 'anywhere')).toBe('anywhere');
  });

  it('tightens at the lower level and loosens at the higher one', () => {
    const rule = SETTINGS_OPERATIONS['hermes.approval-mode'].level;
    expect(levelFor(rule, { mode: 'manual' })).toBe('anywhere');
    expect(levelFor(rule, { mode: 'smart' })).toBe('pc-only');
    expect(levelFor(rule, { mode: 'off' })).toBe('pc-only');
    const staging = SETTINGS_OPERATIONS['hermes.skill-staging'].level;
    expect(levelFor(staging, { enabled: true })).toBe('anywhere');
    expect(levelFor(staging, { enabled: false })).toBe('pc-only');
  });

  it('takes the strictest level for a value the rule does not list', () => {
    const rule = SETTINGS_OPERATIONS['hermes.approval-mode'].level;
    expect(levelFor(rule, { mode: 'yolo' })).toBe('pc-only');
    expect(levelFor(rule, {})).toBe('pc-only');
    expect(levelFor(rule, { mode: 'constructor' })).toBe('pc-only');
  });

  it('asks an undo for the operation\'s strictest level, since undoing a tightening loosens', () => {
    expect(strictestLevel(SETTINGS_OPERATIONS['hermes.approval-mode'].level)).toBe('pc-only');
    expect(undoLevel(SETTINGS_OPERATIONS['hermes.revoke-always'])).toBe('pc-only');
    expect(undoLevel(SETTINGS_OPERATIONS['hermes.default-model'])).toBe('confirm');
  });

  it('pins the level of every operation and every directional parameter', () => {
    const expected: Record<OperationId, SettingsLevel | Record<string, SettingsLevel>> = {
      'hermes.reasoning-effort': 'anywhere', 'hermes.personality': 'anywhere', 'hermes.delegation-limits': 'confirm',
      'paseo.provider-enabled': 'confirm', 'paseo.profile-model': 'confirm', 'paseo.routing-note': 'pc-only',
      'hermes.default-model': 'confirm', 'hermes.delegation-model': 'confirm', 'hermes.delegation-fallbacks': 'confirm',
      'hermes.main-fallbacks': 'confirm', 'hermes.helper-model': 'confirm', 'gateway.point': 'confirm', 'gateway.credential': 'pc-only',
      'hermes.approval-mode': { manual: 'anywhere', smart: 'pc-only', off: 'pc-only' }, 'hermes.revoke-always': 'anywhere',
      'hermes.skill-staging': { true: 'anywhere', false: 'pc-only' }, 'paseo.worker-approvals': { true: 'anywhere', false: 'pc-only' },
      'wayroost.safety-commands': { true: 'pc-only', false: 'anywhere' }, 'wayroost.notifications': 'anywhere',
      'hermes.prompt-keys-move': 'confirm', 'hermes.move-to-roles': 'confirm', 'hermes.coder-mcp-path': 'confirm',
      'pi.coder-mcp-path': 'confirm', 'pi.catalog-roles': 'confirm', 'pi.default-move': 'confirm', 'paseo.profile-move': 'confirm',
      'gateway.restore-recorded': 'confirm', 'gateway.reapply-intended': 'confirm', 'gateway.record-override': 'pc-only', 'gateway.record-migration': 'pc-only',
      'settings.accept-current': 'pc-only', 'gateway.socket-recover': 'confirm', 'hermes.drain-marker-remove': 'confirm',
    };
    expect(Object.keys(expected).sort()).toEqual([...OPERATION_IDS].sort());
    for (const id of OPERATION_IDS) {
      const spec = operationSpec(id)!;
      const levels = expected[id];
      if (typeof levels === 'string') expect(operationLevel(spec, {}), id).toBe(levels);
      else {
        expect('byParam' in spec.level, id).toBe(true);
        if (!('byParam' in spec.level)) throw new Error('a parameter rule is required');
        expect(Object.keys(spec.level.values).sort(), id).toEqual(Object.keys(levels).sort());
        for (const [value, level] of Object.entries(levels)) {
          expect(operationLevel(spec, { [spec.level.byParam]: value === 'true' ? true : value === 'false' ? false : value }), `${id}:${value}`).toBe(level);
        }
      }
    }
  });

  it('allows revoking from a phone but restores an always approval only on the local PC', () => {
    const spec = SETTINGS_OPERATIONS['hermes.revoke-always'];
    expect(decideChange(operationLevel(spec, {}), context({ scopes: PHONE, listener: 'main' }))).toEqual({ allowed: true });
    expect(decideChange(undoLevel(spec), context({ scopes: PHONE, confirmed: true }))).toEqual({ allowed: false, code: 'pc_only' });
    expect(decideChange(undoLevel(spec), context({ listener: 'main' }))).toEqual({ allowed: false, code: 'pc_only' });
    expect(decideChange(undoLevel(spec), context())).toEqual({ allowed: true });
  });
});

describe('who may change what', () => {
  it('lets any device with settings read, and nothing else', () => {
    expect(decideRead({ scopes: PHONE })).toEqual({ allowed: true });
    expect(decideRead({ scopes: ['chats'] })).toEqual({ allowed: false, code: 'not_permitted' });
  });

  it('keeps views with literal commands, arguments and URLs on the local PC', () => {
    for (const view of ['hermes.safety', 'claude.permissions', 'hermes.coder-mcp', 'pi.mcp', 'hermes.models', 'pi.models', 'windows-hermes.models', 'gateway.state', 'opencode.permissions', 'gateway.role-map', 'paseo.agents']) {
      const level = readViewLevel(view);
      expect(level, view).toBe('pc-only');
      expect(decideRead(context({ scopes: PHONE }), level), view).toEqual({ allowed: false, code: 'pc_only' });
      expect(decideRead(context({ listener: 'main' }), level), view).toEqual({ allowed: false, code: 'pc_only' });
      expect(decideRead(context(), level), view).toEqual({ allowed: true });
      expect(decideRead(context({ pcOnlyWrites: false }), level), view).toEqual({ allowed: false, code: 'pc_only_read_only' });
    }
    expect(readViewLevel('hermes.agents')).toBe('pc-only');
    expect(readViewLevel('pi.settings')).toBe('pc-only');
    expect(readViewLevel('wayroost.settings')).toBe('anywhere');
    expect(readViewLevel('constructor')).toBe('pc-only');
  });

  it('refuses every change in shadow, at every level', () => {
    for (const level of ['anywhere', 'confirm', 'pc-only'] as const) {
      expect(decideChange(level, context({ role: 'shadow' }))).toEqual({ allowed: false, code: 'shadow_read_only' });
    }
  });

  it('lets a phone change Anywhere rows, and Confirm rows only with a code', () => {
    const phone = context({ scopes: PHONE, listener: 'main' });
    expect(decideChange('anywhere', phone)).toEqual({ allowed: true });
    expect(decideChange('confirm', phone)).toEqual({ allowed: false, code: 'confirm_required' });
    expect(decideChange('confirm', { ...phone, confirmed: true })).toEqual({ allowed: true });
  });

  it('never lets a phone make a PC-only change, code or not', () => {
    for (const listener of ['main', 'local'] as const) {
      expect(decideChange('pc-only', context({ scopes: PHONE, listener, confirmed: true }))).toEqual({ allowed: false, code: 'pc_only' });
    }
  });

  it('refuses a desktop cookie replayed through the main listener on every PC-only operation', () => {
    const replay = context({ scopes: DESKTOP, listener: 'main' });
    const pcOnly = OPERATION_IDS.flatMap(id => {
      const spec = operationSpec(id)!;
      if (!spec.callers.includes('server')) return [];
      const level = spec.level;
      if ('fixed' in level) return level.fixed === 'pc-only' ? [[id, {}] as const] : [];
      return Object.entries(level.values).filter(([, value]) => value === 'pc-only')
        .map(([value]) => [id, { [level.byParam]: value === 'true' ? true : value === 'false' ? false : value }] as const);
    });
    expect(pcOnly.map(([id]) => id)).toEqual(expect.arrayContaining(['paseo.routing-note', 'gateway.credential', 'hermes.approval-mode', 'hermes.skill-staging']));
    for (const [id, params] of pcOnly) {
      expect(decideChange(operationLevel(operationSpec(id)!, params), replay)).toEqual({ allowed: false, code: 'pc_only' });
      expect(decideChange(operationLevel(operationSpec(id)!, params), { ...replay, listener: 'local' })).toEqual({ allowed: true });
    }
  });

  it('keeps PC-only rows read-only everywhere until the local listener is confirmed', () => {
    expect(decideChange('pc-only', context({ pcOnlyWrites: false }))).toEqual({ allowed: false, code: 'pc_only_read_only' });
    expect(decideChange('confirm', context({ pcOnlyWrites: false }))).toEqual({ allowed: true });
  });

  it('needs no code from the desktop app, as with power actions', () => {
    expect(decideChange('confirm', context({ listener: 'main' }))).toEqual({ allowed: true });
  });

  it('refuses a device without settings', () => {
    expect(decideChange('anywhere', context({ scopes: ['chats'] }))).toEqual({ allowed: false, code: 'not_permitted' });
    expect(decideChange('anywhere', context({ scopes: [] }))).toEqual({ allowed: false, code: 'not_permitted' });
  });

  it('shows rows as editable, with a confirm step, or read-only', () => {
    const phone = { role: 'primary' as const, scopes: PHONE, listener: 'main' as const, pcOnlyWrites: true };
    expect(rowAccess('anywhere', phone)).toBe('editable');
    expect(rowAccess('confirm', phone)).toBe('confirm');
    expect(rowAccess('pc-only', phone)).toBe('read-only');
    expect(rowAccess('pc-only', { ...phone, scopes: DESKTOP, listener: 'local' })).toBe('editable');
  });
});

describe('the route policy table', () => {
  it('covers every settings route and the earlier switches', () => {
    const routes = new Set(SETTINGS_ROUTE_POLICY.map(policy => policy.route));
    for (const route of Object.values(SETTINGS_ROUTES)) expect(routes).toContain(route);
    for (const policy of SETTINGS_ROUTE_POLICY) expect(isSettingsPolicyRoute(policy.route)).toBe(true);
    const pairs = SETTINGS_ROUTE_POLICY.map(policy => `${policy.method} ${policy.route}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('covers remote desktop replays on both safety switch routes', () => {
    for (const route of [SETTINGS_ROUTES.safetyCommands, LEGACY_POLICY_ROUTES.safetyCommands]) {
      const policy = routePolicy('PUT', route)!;
      expect(routePolicyLevel(policy, { enabled: true })).toBe('pc-only');
      expect(routePolicyLevel(policy, { enabled: false })).toBe('anywhere');
      expect(routePolicyLevel(policy, {})).toBe('pc-only');
      expect(decideChange(routePolicyLevel(policy, { enabled: true }) as SettingsLevel, context({ listener: 'main' })))
        .toEqual({ allowed: false, code: 'pc_only' });
    }
    expect(routePolicy('PUT', LEGACY_POLICY_ROUTES.cloudAgent)?.level).toBe('confirm');
    expect(isSettingsPolicyRoute('/api/cloud-agents/demo-agent')).toBe(true);
    expect(isSettingsPolicyRoute('/api/settings/unlisted')).toBe(true);
    expect(isSettingsPolicyRoute('/api/chats')).toBe(false);
    expect(routePolicy('PUT', SETTINGS_ROUTES.notifications)?.level).toBe('anywhere');
  });

  it('leaves the earlier settings routes to their own checks', () => {
    for (const route of EARLIER_SETTINGS_ROUTES) {
      expect(route.startsWith(SETTINGS_ROUTE_PREFIX)).toBe(true);
      expect(SETTINGS_ROUTE_POLICY.some(policy => policy.route === route)).toBe(false);
    }
  });

  it('makes every read Anywhere and every change a write', () => {
    for (const policy of SETTINGS_ROUTE_POLICY) {
      if (policy.method === 'GET') expect(policy).toMatchObject({ level: 'anywhere', write: false });
      else expect(policy.write).toBe(true);
    }
  });

  it('takes apply\'s level from the operation and undo\'s from the change, and keeps keys on the PC', () => {
    expect(routePolicy('POST', SETTINGS_ROUTES.apply)?.level).toBe('operation');
    expect(routePolicy('POST', SETTINGS_ROUTES.undo)?.level).toBe('change');
    expect(routePolicy('PUT', SETTINGS_ROUTES.credential)?.level).toBe('pc-only');
    expect(routePolicy('DELETE', SETTINGS_ROUTES.credential)?.level).toBe('pc-only');
    expect(routePolicy('POST', SETTINGS_ROUTES.credentialTest)?.level).toBe('pc-only');
    const restart = routePolicy('POST', SETTINGS_ROUTES.restart)!;
    expect(routePolicyLevel(restart, { when: 'idle' })).toBe('anywhere');
    expect(routePolicyLevel(restart, { when: 'now' })).toBe('confirm');
    expect(routePolicyLevel(restart, {})).toBe('pc-only');
    expect(routePolicy('PATCH', SETTINGS_ROUTES.apply)).toBeUndefined();
    expect(routePolicy('GET', '/api/settings/unknown')).toBeUndefined();
  });
});
