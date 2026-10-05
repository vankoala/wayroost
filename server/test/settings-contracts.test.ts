import { describe, expect, it } from 'vitest';
import {
  SETTINGS_ERROR_CODES, TIMING_LABELS, VALUE_LIMITS, changeResultSchema, contentVersionSchema, formatKeyPath, isSecretKeyName, keyPathSchema,
  preconditionsSchema, recentChangeSchema, redactedSettingValueSchema, settingValueProblem, settingValueSchema, settingsApplyBodySchema,
  settingsApplyResponseSchema, settingsAuditRecordSchema, settingsCredentialBodySchema, settingsRestartBodySchema,
  notificationDelivery, sameContentVersion, settingValuesEqual, settingsNotificationsBodySchema, settingsSafetyCommandsBodySchema, timingSchema, undoTokenSchema,
} from '../../shared/settings.js';
import type { ServerEvent } from '../../shared/protocol.js';

const sha = (digit: string) => digit.repeat(64);
const token = {
  operation: 'hermes.approval-mode',
  target: 'hermes-config',
  backupId: `${sha('a')}/0000000000000001-demo.bak`,
  backupSha256: sha('b'),
  writtenSha256: sha('c'),
};
const CODE = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ';

describe('redacted read values', () => {
  it('carries only a SHA-256 digest and a nonnegative integer byte length', () => {
    const value = { sha256: sha('a'), length: 0 };
    expect(redactedSettingValueSchema.safeParse(value).success).toBe(true);
    for (const invalid of [{ ...value, length: -1 }, { ...value, length: 0.5 }, { ...value, sha256: 'demo-secret' }, { ...value, text: 'demo-secret' }]) {
      expect(redactedSettingValueSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('timing labels', () => {
  it('has one vocabulary with idle and immediate restarts for each component', () => {
    expect(TIMING_LABELS).toEqual(expect.arrayContaining(['now', 'next-turn', 'next-chat', 'next-run',
      'restart-when-idle:hermes', 'restart-now:dashboard', 'restart-when-idle:gateway', 'restart-now:paseo']));
    expect(new Set(TIMING_LABELS).size).toBe(TIMING_LABELS.length);
  });

  it('accepts a label per surface and refuses unknown labels or surfaces', () => {
    expect(timingSchema.safeParse([{ label: 'next-turn', surface: 'messaging' }, { label: 'next-chat', surface: 'app-chats' }]).success).toBe(true);
    expect(timingSchema.safeParse([]).success).toBe(false);
    expect(timingSchema.safeParse([{ label: 'restart-when-idle:everything' }]).success).toBe(false);
    expect(timingSchema.safeParse([{ label: 'now', surface: 'email' }]).success).toBe(false);
  });
});

describe('error codes', () => {
  it('are unique snake_case words and include the ones every write path relies on', () => {
    expect(new Set(SETTINGS_ERROR_CODES).size).toBe(SETTINGS_ERROR_CODES.length);
    for (const code of SETTINGS_ERROR_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    expect(SETTINGS_ERROR_CODES).toEqual(expect.arrayContaining(['parse_failed', 'precondition_changed', 'unsafe_directory',
      'verify_mismatch', 'shadow_read_only', 'audit_unavailable', 'undo_changed', 'pc_only_read_only']));
  });
});

describe('setting values', () => {
  it('accepts JSON values', () => {
    for (const value of [null, true, 3, 'text', [1, 'two'], { nested: { list: [false] } }]) {
      expect(settingValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses an own __proto__ key instead of dropping it', () => {
    const value = JSON.parse('{"a": {"__proto__": {"injected": true}}}');
    expect(settingValueProblem(value)).toBe('a reserved key');
    expect(settingValueSchema.safeParse(value).success).toBe(false);
  });

  it('refuses what JSON cannot carry and anything past its limits', () => {
    expect(settingValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(settingValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(settingValueSchema.safeParse(undefined).success).toBe(false);
    expect(settingValueSchema.safeParse(new Date(0)).success).toBe(false);
    expect(settingValueSchema.safeParse('x'.repeat(VALUE_LIMITS.stringLength + 1)).success).toBe(false);
    let deep: unknown = 'leaf';
    for (let level = 0; level <= VALUE_LIMITS.depth; level++) deep = [deep];
    expect(settingValueProblem(deep)).toBe('nested too deeply');
    expect(settingValueProblem(Array.from({ length: VALUE_LIMITS.nodes }, () => 0))).toBe('too many values');
  });
});

describe('key paths', () => {
  it('names keys for audits without values', () => {
    expect(formatKeyPath(['model', 'default'])).toBe('model.default');
    expect(formatKeyPath(['auxiliary', 'compression', 'provider'])).toBe('auxiliary.compression.provider');
    expect(formatKeyPath(['fallback_providers', 0, 'model'])).toBe('fallback_providers[0].model');
    expect(formatKeyPath(['daemon', 'agentProfiles', { id: 'demo-coder' }, 'model'])).toBe('daemon.agentProfiles[id="demo-coder"].model');
    expect(formatKeyPath(['providers', 'odd.name'])).toBe('providers["odd.name"]');
    expect(formatKeyPath(['agents', 'providers', '*', 'paseoTools'])).toBe('agents.providers.*.paseoTools');
  });

  it('refuses empty, reserved and overlong paths', () => {
    expect(keyPathSchema.safeParse([]).success).toBe(false);
    expect(keyPathSchema.safeParse(['__proto__']).success).toBe(false);
    expect(keyPathSchema.safeParse(Array.from({ length: 13 }, () => 'a')).success).toBe(false);
    expect(keyPathSchema.safeParse(['a', -1]).success).toBe(false);
  });

  it('tells secret-looking key names from counts', () => {
    for (const name of ['api_key', 'apiKey', 'OPENAI_API_KEY', 'Authorization', 'headers', 'accessToken', 'password', 'x-api-key', 'apikey']) {
      expect(isSecretKeyName(name)).toBe(true);
    }
    for (const name of ['maxTokens', 'max_tokens', 'base_url', 'provider', 'model', 'keys', 'contextWindow', 'monkey']) {
      expect(isSecretKeyName(name)).toBe(false);
    }
  });
});

describe('undo tokens and preconditions', () => {
  it('accepts a token and refuses traversal in a backup id', () => {
    expect(undoTokenSchema.safeParse(token).success).toBe(true);
    expect(undoTokenSchema.safeParse({ ...token, backupId: '../outside.bak' }).success).toBe(false);
    expect(undoTokenSchema.safeParse({ ...token, backupId: `${sha('a')}/..` }).success).toBe(false);
    expect(undoTokenSchema.safeParse({ ...token, path: '/home/me/.demo/config.yaml' }).success).toBe(false);
  });

  it('holds either the whole file hash or key-scoped values', () => {
    expect(preconditionsSchema.safeParse({ file: { sha256: sha('d') } }).success).toBe(true);
    expect(preconditionsSchema.safeParse({ keys: [{ key: 0, value: 'manual' }, { key: 1, exists: false }] }).success).toBe(true);
    expect(preconditionsSchema.safeParse({ keys: [{ key: 0, exists: true }] }).success).toBe(false);
    expect(preconditionsSchema.safeParse({ keys: [{ path: ['approvals', 'mode'], value: 'manual' }] }).success).toBe(false);
    expect(preconditionsSchema.safeParse({ file: { sha256: sha('d') }, keys: [] }).success).toBe(false);
  });

  it('compares content and values without treating a new mtime as drift', () => {
    const before = { sha256: sha('d'), mtimeNs: '100' };
    const rewritten = { sha256: sha('d'), mtimeNs: '200' };
    expect(sameContentVersion(before, rewritten)).toBe(true);
    expect(sameContentVersion(before, { sha256: sha('e') })).toBe(false);
    expect(contentVersionSchema.safeParse(before).success).toBe(false);
    expect(preconditionsSchema.safeParse({ file: before }).success).toBe(false);
    expect(settingValuesEqual({ a: 'manual', b: [1, 2] }, { b: [1, 2], a: 'manual' })).toBe(true);
    expect(settingValuesEqual('manual', 'off')).toBe(false);
    expect(settingValuesEqual(undefined, '')).toBe(false);
    expect(settingValuesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(settingValuesEqual([], {})).toBe(false);
  });

  it('refuses unknown target ids in undo tokens', () => {
    expect(undoTokenSchema.safeParse({ ...token, target: 'unknown-target' }).success).toBe(false);
    expect(undoTokenSchema.safeParse({ ...token, target: 'wayroost-settings' }).success).toBe(true);
  });
});

describe('settings API bodies', () => {
  it('takes an operation id with parameters, optional preconditions and a confirm code', () => {
    const body = settingsApplyBodySchema.parse({ operation: 'hermes.default-model', params: { provider: 'demo' }, confirm: CODE });
    expect(body.params).toEqual({ provider: 'demo' });
    expect(settingsApplyBodySchema.parse({ operation: 'gateway.point' }).params).toEqual({});
    expect(settingsApplyBodySchema.safeParse({ operation: '../etc/passwd' }).success).toBe(false);
    expect(settingsApplyBodySchema.safeParse({ operation: 'hermes.default-model', path: '/home/me/x' }).success).toBe(false);
    expect(settingsApplyBodySchema.safeParse({ operation: 'hermes.default-model', confirm: '123456' }).success).toBe(false);
    expect(settingsApplyBodySchema.safeParse({ operation: 'hermes.default-model', params: ['provider'] }).success).toBe(false);
    expect(settingsApplyBodySchema.safeParse({ operation: 'hermes.default-model', params: 'provider=demo' }).success).toBe(false);
    const smuggled = settingsApplyBodySchema.parse(JSON.parse('{"operation": "hermes.approval-mode", "params": {"__proto__": {"mode": "off"}}}'));
    expect(Object.hasOwn(smuggled.params, '__proto__')).toBe(true);
  });

  it('keeps the dashboard to immediate restarts and keys to plain printable text', () => {
    expect(settingsRestartBodySchema.safeParse({ component: 'hermes', when: 'idle' }).success).toBe(true);
    expect(settingsRestartBodySchema.safeParse({ component: 'dashboard', when: 'now' }).success).toBe(true);
    expect(settingsRestartBodySchema.safeParse({ component: 'dashboard', when: 'idle' }).success).toBe(false);
    expect(settingsRestartBodySchema.safeParse({ component: 'paseo', when: 'now' }).success).toBe(false);
    expect(settingsCredentialBodySchema.safeParse({ secret: 'demo-key-0123' }).success).toBe(true);
    expect(settingsCredentialBodySchema.safeParse({ secret: 'demo key' }).success).toBe(false);
    expect(settingsCredentialBodySchema.safeParse({ secret: 'demo-key\n' }).success).toBe(false);
  });

  it('answers with a confirm step, a change, or a fixed code', () => {
    const change = {
      id: 'ch_0123456789abcdef01234567', operation: 'gateway.point', target: 'gateway-role-map', keys: ['roles.main'],
      timing: [{ label: 'now' }], lasts: 'until-next-switch', effective: 'verified', undoable: true,
    };
    expect(changeResultSchema.safeParse(change).success).toBe(true);
    expect(changeResultSchema.safeParse({ ...change, target: 'unknown-target' }).success).toBe(false);
    expect(settingsApplyResponseSchema.safeParse({ status: 'applied', change }).success).toBe(true);
    expect(settingsApplyResponseSchema.safeParse({ status: 'confirm', confirm: CODE, summary: 'Point main at another backend.', expiresAt: 1 }).success).toBe(true);
    expect(settingsApplyResponseSchema.safeParse({ status: 'refused', code: 'verify_mismatch', change }).success).toBe(true);
    expect(settingsApplyResponseSchema.safeParse({ status: 'refused', code: 'verify_mismatch', message: 'raw upstream text' }).success).toBe(false);
    expect(settingsApplyResponseSchema.safeParse({ status: 'refused', code: 'something_new' }).success).toBe(false);
  });

  it('carries notification rules, overnight quiet hours and the safety switch', () => {
    const body = { push: { approvals: true, cards: false }, quietHours: { start: '21:00', end: '07:00' } };
    expect(settingsNotificationsBodySchema.safeParse(body).success).toBe(true);
    expect(settingsNotificationsBodySchema.safeParse({ ...body, quietHours: null }).success).toBe(true);
    expect(settingsNotificationsBodySchema.safeParse({ ...body, quietHours: { start: '24:00', end: '07:00' } }).success).toBe(false);
    expect(settingsNotificationsBodySchema.safeParse({ ...body, quietHours: { start: '21:60', end: '07:00' } }).success).toBe(false);
    expect(settingsNotificationsBodySchema.safeParse({ ...body, command: 'id' }).success).toBe(false);
    expect(settingsSafetyCommandsBodySchema.safeParse({ enabled: true }).success).toBe(true);
    expect(settingsSafetyCommandsBodySchema.safeParse({ enabled: 'true' }).success).toBe(false);
  });

  it('carries event and source rules for every delivery choice', () => {
    const body = { push: { approvals: true, cards: true }, quietHours: null };
    for (const delivery of ['toast', 'push', 'both', 'neither']) {
      expect(settingsNotificationsBodySchema.safeParse({ ...body,
        rules: [{ event: 'agent-finished', source: 'hermes', delivery }] }).success, delivery).toBe(true);
    }
    expect(settingsNotificationsBodySchema.safeParse({ ...body, rules: [
      { event: 'agent-needs-you', source: '*', delivery: 'both' },
      { event: 'agent-finished', source: 'paseo', delivery: 'toast' },
      { event: 'feed-card', source: 'brief', delivery: 'push' },
      { event: 'feed-card', source: 'scout', delivery: 'neither' },
    ] }).success).toBe(true);
  });

  it('keeps agent-needs-you delivery available during quiet hours', () => {
    const body = { push: { approvals: false, cards: false }, quietHours: { start: '21:00', end: '07:00' } };
    for (const delivery of ['toast', 'both']) {
      expect(settingsNotificationsBodySchema.safeParse({ ...body,
        rules: [{ event: 'agent-needs-you', source: 'hermes', delivery }] }).success, delivery).toBe(true);
    }
    for (const delivery of ['neither', 'push']) {
      expect(settingsNotificationsBodySchema.safeParse({ ...body,
        rules: [{ event: 'agent-needs-you', source: 'hermes', delivery }] }).success, delivery).toBe(false);
    }
  });

  it('configures settings outcomes, mismatch warnings and security cards independently', () => {
    const body = { push: { approvals: true, cards: true }, quietHours: null };
    const rules = [
      { event: 'settings-applied', source: '*', delivery: 'toast' },
      { event: 'settings-failed', source: '*', delivery: 'both' },
      { event: 'mismatch-warning', source: '*', delivery: 'push' },
      { event: 'security-card', source: '*', delivery: 'neither' },
    ];
    const parsed = settingsNotificationsBodySchema.safeParse({ ...body, rules });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.rules).toEqual(rules);
    for (const rule of parsed.data.rules) {
      expect(notificationDelivery(rule.event, 'supervisor', parsed.data.rules)).toBe(rule.delivery);
      for (const delivery of ['toast', 'push', 'both', 'neither']) {
        expect(settingsNotificationsBodySchema.safeParse({ ...body, rules: [{ ...rule, delivery }] }).success).toBe(true);
      }
    }
  });

  it('refuses unknown notification selectors and ambiguous duplicate rules', () => {
    const body = { push: { approvals: true, cards: true }, quietHours: null };
    const rule = { event: 'agent-finished', source: 'hermes', delivery: 'toast' };
    for (const patch of [{ event: 'unknown' }, { source: 'unknown' }, { delivery: 'unknown' }, { command: 'id' }]) {
      expect(settingsNotificationsBodySchema.safeParse({ ...body, rules: [{ ...rule, ...patch }] }).success).toBe(false);
    }
    expect(settingsNotificationsBodySchema.safeParse({ ...body, rules: [rule, { ...rule, delivery: 'push' }] }).success).toBe(false);
  });

  it('resolves source overrides and keeps mandatory delivery when rules are absent', () => {
    const body = { push: { approvals: false, cards: false }, quietHours: null };
    const rules = settingsNotificationsBodySchema.parse({ ...body, rules: [
      { event: 'agent-finished', source: '*', delivery: 'toast' },
      { event: 'agent-finished', source: 'hermes', delivery: 'neither' },
    ] }).rules;
    expect(notificationDelivery('agent-finished', 'hermes', rules)).toBe('neither');
    expect(notificationDelivery('agent-finished', 'paseo', rules)).toBe('toast');
    expect(notificationDelivery('agent-needs-you', 'hermes', rules)).toBe('both');
    expect(notificationDelivery('agent-needs-you', 'paseo', [])).toBe('both');
    expect(notificationDelivery('agent-needs-you', 'paseo', [{ event: 'agent-needs-you', source: '*', delivery: 'neither' }])).toBe('toast');
    expect(notificationDelivery('agent-needs-you', 'paseo', [{ event: 'agent-needs-you', source: '*', delivery: 'push' }])).toBe('both');
    const first = settingsNotificationsBodySchema.parse(body);
    expect(notificationDelivery('agent-needs-you', 'hermes', first.rules)).toBe('both');
    first.rules[0]!.delivery = 'toast';
    expect(settingsNotificationsBodySchema.parse(body).rules[0]!.delivery).toBe('both');
  });
});

describe('audit and recent changes', () => {
  const record = {
    id: 'ch_0123456789abcdef01234567', at: 1, action: 'apply', operation: 'hermes.approval-mode', target: 'hermes-config',
    keys: ['approvals.mode'], backupId: token.backupId, backupSha256: sha('b'), writtenSha256: sha('c'),
    device: { id: 'dv_0123456789abcdef01234567', kind: 'desktop' }, level: 'pc-only', timing: ['next-turn'], result: 'ok',
  };

  it('records key names, ids and hashes', () => {
    expect(settingsAuditRecordSchema.safeParse(record).success).toBe(true);
  });

  it.each(['value', 'values', 'before', 'after', 'params', 'message'])('has no field %s that could hold a value', field => {
    expect(settingsAuditRecordSchema.safeParse({ ...record, [field]: 'smart' }).success).toBe(false);
  });

  it('lists recent changes with their device, level and timing', () => {
    expect(recentChangeSchema.safeParse({
      id: record.id, at: 1, action: 'undo', operation: 'hermes.approval-mode', target: 'hermes-config', keys: ['approvals.mode'],
      device: { id: 'dv_0123456789abcdef01234567', name: 'Demo phone', kind: 'phone' }, level: 'pc-only',
      timing: [{ label: 'next-turn' }], result: 'ok', undoable: false,
    }).success).toBe(true);
  });
});

describe('events', () => {
  it('carries ids and sections only', () => {
    const events: ServerEvent[] = [
      { type: 'settings_changed', sections: ['safety'], change: 'ch_0123456789abcdef01234567' },
      { type: 'usage_changed' },
    ];
    expect(events.map(event => Object.keys(event).sort())).toEqual([['change', 'sections', 'type'], ['type']]);
  });
});
