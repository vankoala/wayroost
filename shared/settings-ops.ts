// The operation catalogue: every settings change Wayroost can make, by id. A
// request names an operation and its typed parameters, never a path, a key, a
// command or a shell string. Each entry says which target it edits, which keys
// it may add, change or delete, its level, when it takes effect, and who may ask
// for it: the server (for a device), the stack launcher (with its own key) or
// the supervisor itself (state it records once a change is verified). Values
// that aren't parameters come from the site file, the role map or the gateway
// migration record, all root-owned.
import { z } from 'zod';
import { INVISIBLE } from './invisible.js';
import { CONSUMER_TARGETS, GATEWAY_CONSUMERS, GATEWAY_ROLES, ROLE_PROVIDERS, backendIdSchema, gatewayRoleSchema, isLoopbackUrl, type GatewayConsumer } from './gateway.js';
import { decideRead, levelFor, strictestLevel, type LevelRule } from './settings-levels.js';
import { CHANGE_ID, targetIdSchema, MAX_OPERATION_KEYS, formatKeyPath, isSecretKeyName, keyPathSchema, settingsNotificationsBodySchema, settingsSafetyCommandsBodySchema, sha256Schema,
  settingValueSchema, redactedSettingValueSchema, settingComparisonJson, type KeyPath, type KeySegment, type RedactedSettingValue, type SettingValue, type SettingsLevel, type SettingsSection, type Timing } from './settings.js';
import { OWNER_FILE_TARGETS, type OwnerFileTarget, type TargetId } from './settings-targets.js';

/** Bumped whenever an operation is added, removed or changes shape; the supervisor reports it. */
export const CATALOGUE_VERSION = 9;

export const RECOVERY_OPERATIONS = ['gateway.socket-recover', 'hermes.drain-marker-remove'] as const;

// ---- Parameter shapes --------------------------------------------------------

/** A provider name in Hermes' providers or pi's catalog. */
export const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A model name as a provider serves it: "demo-model", "vendor/demo-model:free". */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
export const providerIdSchema = z.string().regex(PROVIDER_ID);
export const modelIdSchema = z.string().regex(MODEL_ID);
const modelRef = z.object({ provider: providerIdSchema, model: modelIdSchema }).strict();
export const fallbackChainSchema = z.array(modelRef).max(8);
const loopbackUrl = z.string().refine(isLoopbackUrl, 'an http loopback address');

/** Hermes' helper tasks that take a provider and a model (auxiliary.<task>). Vision and the MoA slots aren't offered. */
export const HERMES_HELPER_TASKS = [
  'compression', 'skills_hub', 'approval', 'mcp', 'title_generation', 'memory_query_rewrite', 'tts_audio_tags',
  'triage_specifier', 'kanban_decomposer', 'profile_describer', 'goal_judge', 'curator', 'monitor', 'background_review',
] as const;
export const REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const HERMES_PERSONALITIES = ['', 'helpful', 'concise', 'technical', 'creative', 'teacher', 'kawaii', 'catgirl', 'pirate', 'shakespeare', 'surfer', 'noir', 'uwu', 'philosopher', 'hype'] as const;
/** manual: always ask. smart: a model guardian approves flagged commands. off: never ask. */
export const APPROVAL_MODES = ['manual', 'smart', 'off'] as const;
/** Paseo agents Settings can switch on or off, by Paseo provider id. */
export const PASEO_AGENT_PROVIDERS = ['claude', 'codex', 'opencode', 'copilot', 'hermes'] as const;
/** Built-in providers get a tools entry even when they have no persisted entry yet. */
export const PASEO_BUILTIN_PROVIDERS = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp'] as const;
/** Paseo profile ids. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A Paseo profile's model as pi names it: "<provider>/<model>". */
export const PROFILE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
export const ROUTING_NOTE_MAX = 4000;

/**
 * Hermes' prompt-shaping keys: "auto", forced on or off, or a list of
 * model-name substrings. null removes the key (Hermes' default applies).
 */
export const promptKeyValueSchema = z.union([
  z.literal('auto'),
  z.boolean(),
  z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(32),
]).nullable();

/** Consumers and files a recorded-state operation may name (the phone's drop-in is the launcher's own). */
const migrationPair = z.object({
  consumer: z.enum(['coder-mcp', 'hermes', 'pi']),
  target: z.enum(OWNER_FILE_TARGETS),
});
const pairListed = (params: { consumer: GatewayConsumer; target: OwnerFileTarget }) =>
  (CONSUMER_TARGETS[params.consumer] as readonly string[]).includes(params.target);
/** Files whose keys follow the serving model when a consumer is moved back. */
const MODEL_DEPENDENT_TARGETS: readonly OwnerFileTarget[] = ['hermes-config', 'pi-settings', 'pi-models'];

const plainText = (text: string) => {
  const spaced = text.replace(/[\n\t]/g, ' ');
  return spaced.replace(INVISIBLE, '') === spaced;
};

// ---- Catalogue entries -------------------------------------------------------

/**
 * One step of a key: a literal key; `*` for every existing entry; a parameter's value
 * as the key (an array parameter gives one key per element); or Paseo's
 * profile whose id is that parameter. Keys of the gateway-state target start
 * with the file: "state" or "migration". `entriesIncluding` resolves existing
 * names plus the listed missing ones. Only ancestors needed for these leaves
 * may be created; other fields of a newly created entry remain forbidden.
 */
export type KeyTemplateSegment = string | { readonly param: string } | { readonly idParam: string }
  | { readonly entriesIncluding: readonly string[] };
export type KeyTemplate = readonly KeyTemplateSegment[];

export type OperationCaller = 'server' | 'launcher' | 'supervisor';
/** Each changed key must match a group; wildcards match one path segment. */
export interface KeyTimingRule {
  readonly byKeys: readonly { readonly keys: readonly KeyPath[]; readonly timing: Timing }[];
}
/** A timing that depends on parameters: `values` is keyed by those parameters' values joined with "/". */
export type TimingRule = Timing | KeyTimingRule
  | { readonly byParams: readonly string[]; readonly values: Readonly<Record<string, Timing | KeyTimingRule>> };

export interface OperationSpec {
  /** Plain words for pages and the audit. */
  title: string;
  section: SettingsSection;
  /** The target it edits, or `{ param: 'target' }` when a parameter names it. */
  target: TargetId | { readonly param: 'target' };
  /** settings.resolve records a server-held resolution; credential.write carries the key beside its parameters. */
  verb: 'config.apply' | 'credential.write' | 'settings.resolve';
  params: z.ZodType<Record<string, unknown>>;
  level: LevelRule;
  /** Overrides the strictest forward level when undo restores a looser policy. */
  undoLevel?: SettingsLevel;
  timing: TimingRule;
  /** The keys it may add, change or delete; `recorded`: the keys the migration record holds for that consumer and file. */
  keys: readonly KeyTemplate[] | 'recorded';
  callers: readonly OperationCaller[];
  /** The consumer whose moved keys it writes. */
  consumer?: GatewayConsumer;
  /**
   * What the supervisor records once the change is verified: `move` the keys'
   * values before and after (the consumer is then moved), `intended` the new
   * value of a moved key, `restore` the consumer back (not moved), `override`
   * a manual role change. A failed record is `verify_mismatch`.
   */
  records?: 'move' | 'intended' | 'restore' | 'override';
  lasts?: 'until-next-switch';
  /** A fixed service recovery has no configuration backup or inverse change. */
  recovery?: true;
}

const NOW: Timing = [{ label: 'now' }];
const NEXT_TURN: Timing = [{ label: 'next-turn' }];
const NEXT_CHAT: Timing = [{ label: 'next-chat' }];
const NEW_PI_AGENTS: Timing = [{ surface: 'pi-agents', label: 'next-chat' }];
const PASEO_RESTART: Timing = [{ label: 'restart-now:paseo' }];
const HERMES_MCP: Timing = [{ surface: 'messaging', label: 'restart-when-idle:hermes' }, { surface: 'app-chats', label: 'restart-now:dashboard' }];
const HERMES_MODEL: Timing = [
  { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'next-turn' },
  { surface: 'app-chats', label: 'next-turn', keys: ['model.default', 'model.provider', 'model.base_url'], when: 'model-or-provider-changed' },
  { surface: 'app-chats', label: 'next-chat', keys: ['model.base_url'], when: 'base-url-only' }, { surface: 'jobs', label: 'next-run' },
];
/** display.personality and agent.system_prompt overlays are unused by API and scheduled agents. */
export const HERMES_OVERLAY_TIMING: Timing = [
  { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'not-used' },
  { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'not-used' },
];
const HERMES_PROMPT_KEYS: Timing = [
  { surface: 'messaging', label: 'next-chat' }, { surface: 'api', label: 'next-chat' },
  { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'next-run' },
];
/** By consumer and file, for operations that name both. */
const BY_CONSUMER_TARGET: TimingRule = {
  byParams: ['consumer', 'target'],
  values: {
    'coder-mcp/hermes-config': HERMES_MCP,
    'coder-mcp/pi-mcp': NEW_PI_AGENTS,
    'hermes/hermes-config': { byKeys: [
      { keys: [['model', 'provider'], ['model', 'default'], ['model', 'base_url']], timing: HERMES_MODEL },
      { keys: [['agent', 'tool_use_enforcement'], ['agent', 'execution_guidance'], ['model', 'reasoning_echo']], timing: HERMES_PROMPT_KEYS },
      { keys: [['delegation', '*']], timing: NOW },
      { keys: [['auxiliary', '*', 'provider'], ['auxiliary', '*', 'model'], ['fallback_providers']], timing: NEXT_TURN },
      { keys: [['providers', '*']], timing: [
        { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'next-turn' },
        { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'next-run' },
      ] },
    ] },
    'pi/pi-models': PASEO_RESTART,
    'pi/pi-settings': NEW_PI_AGENTS,
    'pi/paseo-config': NOW,
  },
};

const anywhere: LevelRule = { fixed: 'anywhere' };
const confirm: LevelRule = { fixed: 'confirm' };
const pcOnly: LevelRule = { fixed: 'pc-only' };
/** Never requested by a device: the supervisor's own state writes. */
const internal: LevelRule = { fixed: 'pc-only' };
const HERMES_ROLE_PROVIDERS: KeyTemplate[] = Object.values(ROLE_PROVIDERS).map(provider => ['providers', provider]);

export const SETTINGS_OPERATIONS = {
  // Agents
  'hermes.reasoning-effort': {
    title: 'Reasoning effort', section: 'agents', target: 'hermes-config', verb: 'config.apply',
    /** null removes the override so Hermes' default applies. */
    params: z.object({ effort: z.enum(REASONING_EFFORTS).nullable() }).strict(),
    level: anywhere, timing: [
      { surface: 'messaging', label: 'next-turn' }, { surface: 'api', label: 'next-turn' },
      { surface: 'app-chats', label: 'next-chat' }, { surface: 'jobs', label: 'next-run' },
    ], keys: [['agent', 'reasoning_effort']], callers: ['server'],
  },
  'hermes.personality': {
    title: 'Personality', section: 'agents', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ personality: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/) }).strict(),
    level: anywhere, timing: HERMES_OVERLAY_TIMING,
    keys: [['display', 'personality']], callers: ['server'],
  },
  'hermes.delegation-limits': {
    title: 'Delegation limits', section: 'agents', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ maxConcurrentChildren: z.number().int().min(1).max(64), maxIterations: z.number().int().min(1).max(10_000) }).strict(),
    level: confirm, timing: NOW, keys: [['delegation', 'max_concurrent_children'], ['delegation', 'max_iterations']], callers: ['server'],
  },
  'paseo.provider-enabled': {
    title: 'Paseo agent on or off', section: 'agents', target: 'paseo-config', verb: 'config.apply',
    params: z.object({ provider: z.enum(PASEO_AGENT_PROVIDERS), enabled: z.boolean() }).strict(),
    level: confirm, timing: NOW, keys: [['agents', 'providers', { param: 'provider' }, 'enabled']], callers: ['server'],
  },
  'paseo.profile-model': {
    title: 'Profile model', section: 'agents', target: 'paseo-config', verb: 'config.apply',
    params: z.object({ profile: z.string().regex(PROFILE_NAME), model: z.string().regex(PROFILE_MODEL) }).strict(),
    level: confirm, timing: NOW, keys: [['daemon', 'agentProfiles', { idParam: 'profile' }, 'model']], callers: ['server'],
    consumer: 'pi', records: 'intended',
  },
  'paseo.routing-note': {
    title: 'Routing note', section: 'agents', target: 'paseo-config', verb: 'config.apply',
    /** An empty note removes the key. */
    params: z.object({ text: z.string().max(ROUTING_NOTE_MAX).refine(plainText, 'plain text') }).strict(),
    level: pcOnly, timing: NEXT_CHAT, keys: [['daemon', 'appendSystemPrompt']], callers: ['server'],
  },

  // Models & accounts
  'hermes.default-model': {
    title: 'Default model', section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: modelRef.extend({ baseUrl: loopbackUrl }).strict(),
    level: confirm, timing: HERMES_MODEL, keys: [['model', 'provider'], ['model', 'default'], ['model', 'base_url']], callers: ['server'],
    consumer: 'hermes', records: 'intended',
  },
  'hermes.delegation-model': {
    title: 'Delegation model', section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: modelRef,
    level: confirm, timing: NOW, keys: [['delegation', 'provider'], ['delegation', 'model']], callers: ['server'],
    consumer: 'hermes', records: 'intended',
  },
  'hermes.delegation-fallbacks': {
    title: 'Delegation fallbacks', section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ chain: fallbackChainSchema }).strict(),
    level: confirm, timing: NOW, keys: [['delegation', 'fallback_providers']], callers: ['server'],
    consumer: 'hermes', records: 'intended',
  },
  'hermes.main-fallbacks': {
    title: 'Main model fallbacks', section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ chain: fallbackChainSchema }).strict(),
    level: confirm, timing: NEXT_TURN, keys: [['fallback_providers']], callers: ['server'],
  },
  'hermes.helper-model': {
    title: 'Helper model', section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: modelRef.extend({ task: z.enum(HERMES_HELPER_TASKS) }).strict(),
    level: confirm, timing: NEXT_TURN,
    keys: [['auxiliary', { param: 'task' }, 'provider'], ['auxiliary', { param: 'task' }, 'model']], callers: ['server'],
    consumer: 'hermes', records: 'intended',
  },
  'gateway.point': {
    title: "A role's backend", section: 'models', target: 'gateway-role-map', verb: 'config.apply',
    params: z.object({ role: gatewayRoleSchema, backend: backendIdSchema }).strict(),
    level: confirm, timing: NOW, keys: [['roles', { param: 'role' }]], callers: ['server'],
    records: 'override', lasts: 'until-next-switch',
  },
  'gateway.credential': {
    title: 'API key', section: 'models', target: 'gateway-credentials', verb: 'credential.write',
    params: z.object({ provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), action: z.enum(['set', 'remove']) }).strict(),
    level: pcOnly, timing: [{ label: 'restart-when-idle:gateway' }], keys: [[{ param: 'provider' }]], callers: ['server'],
  },

  // Safety
  'hermes.approval-mode': {
    title: 'Approval mode', section: 'safety', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ mode: z.enum(APPROVAL_MODES) }).strict(),
    level: { byParam: 'mode', values: { manual: 'anywhere', smart: 'pc-only', off: 'pc-only' } },
    timing: NOW, keys: [['approvals', 'mode']], callers: ['server'],
  },
  'hermes.revoke-always': {
    title: 'Revoke an "always" entry', section: 'safety', target: 'hermes-config', verb: 'config.apply',
    /** The request hashes the persisted entry's UTF-8 text, before Hermes expands variables. */
    params: z.object({ entrySha256: sha256Schema }).strict(),
    level: anywhere, undoLevel: 'pc-only',
    timing: [
      { surface: 'app-chats', label: 'next-chat', refresh: 'next-app-chat-build', sessionApproval: 'until-session-ends' },
      { surface: 'messaging', label: 'restart-when-idle:hermes', refresh: 'next-always-answer', sessionApproval: 'until-session-ends' },
      { surface: 'api', label: 'restart-when-idle:hermes', refresh: 'next-always-answer', sessionApproval: 'until-session-ends' },
      { surface: 'jobs', label: 'next-run', sessionApproval: 'until-session-ends' },
    ],
    keys: [['command_allowlist']], callers: ['server'],
  },
  'hermes.skill-staging': {
    title: 'Skill changes wait for your OK', section: 'safety', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ enabled: z.boolean() }).strict(),
    level: { byParam: 'enabled', values: { true: 'anywhere', false: 'pc-only' } },
    timing: NOW, keys: [['skills', 'write_approval']], callers: ['server'],
  },
  'paseo.worker-approvals': {
    title: "Workers' approvals come to me", section: 'safety', target: 'paseo-config', verb: 'config.apply',
    params: z.object({ enabled: z.boolean() }).strict(),
    level: { byParam: 'enabled', values: { true: 'anywhere', false: 'pc-only' } },
    timing: NEXT_CHAT, keys: [['agents', 'providers', { entriesIncluding: PASEO_BUILTIN_PROVIDERS }, 'paseoTools']], callers: ['server'],
  },

  'wayroost.safety-commands': {
    title: 'Hermes safety commands', section: 'safety', target: 'wayroost-settings', verb: 'config.apply',
    params: settingsSafetyCommandsBodySchema,
    level: { byParam: 'enabled', values: { true: 'pc-only', false: 'anywhere' } },
    timing: NOW, keys: [['safetyCommandsEnabled']], callers: ['server'],
  },
  'wayroost.notifications': {
    title: 'Notification rules and quiet hours', section: 'notifications', target: 'wayroost-settings', verb: 'config.apply',
    params: settingsNotificationsBodySchema, level: anywhere, timing: NOW,
    keys: [['push'], ['quietHours'], ['rules']], callers: ['server'],
  },

  // The stack launcher's moves onto roles. Values come from the site file and the role map.
  'hermes.prompt-keys-move': {
    title: "Hermes' prompt keys for roles", section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: z.object({ toolUseEnforcement: promptKeyValueSchema, executionGuidance: promptKeyValueSchema, reasoningEcho: z.boolean().nullable() }).strict(),
    level: confirm, timing: HERMES_PROMPT_KEYS,
    keys: [['agent', 'tool_use_enforcement'], ['agent', 'execution_guidance'], ['model', 'reasoning_echo']], callers: ['launcher'],
    consumer: 'hermes', records: 'move',
  },
  'hermes.move-to-roles': {
    title: 'Hermes onto roles', section: 'models', target: 'hermes-config', verb: 'config.apply',
    /** Adds the role providers; main for the model and delegation, coder then `directFallback` behind it, fast for the listed helpers. */
    params: z.object({
      helperTasks: z.array(z.enum(HERMES_HELPER_TASKS)).min(1).max(HERMES_HELPER_TASKS.length).refine(tasks => new Set(tasks).size === tasks.length, 'each task once'),
      directFallback: modelRef,
    }).strict(),
    level: confirm, timing: [...HERMES_MODEL, { label: 'now', keys: ['delegation.provider', 'delegation.model', 'delegation.fallback_providers'] }],
    keys: [
      ...HERMES_ROLE_PROVIDERS,
      ['model', 'provider'], ['model', 'default'], ['model', 'base_url'],
      ['delegation', 'provider'], ['delegation', 'model'], ['delegation', 'fallback_providers'],
      ['auxiliary', { param: 'helperTasks' }, 'provider'], ['auxiliary', { param: 'helperTasks' }, 'model'],
    ],
    callers: ['launcher'], consumer: 'hermes', records: 'move',
  },
  'hermes.coder-mcp-path': {
    title: "Hermes' coder MCP onto the gateway copy", section: 'models', target: 'hermes-config', verb: 'config.apply',
    params: z.object({}).strict(),
    level: confirm, timing: HERMES_MCP, keys: [['mcp_servers', 'coder', 'args']], callers: ['launcher'],
    consumer: 'coder-mcp', records: 'move',
  },
  'pi.coder-mcp-path': {
    title: "pi's coder MCP onto the gateway copy", section: 'models', target: 'pi-mcp', verb: 'config.apply',
    params: z.object({}).strict(),
    level: confirm, timing: NEW_PI_AGENTS, keys: [['mcpServers', 'coder', 'args']], callers: ['launcher'],
    consumer: 'coder-mcp', records: 'move',
  },
  'pi.catalog-roles': {
    title: "Roles first in pi's catalog", section: 'models', target: 'pi-models', verb: 'config.apply',
    /** Adds the role providers, matching their contracts, ahead of every other provider, which keep their order. */
    params: z.object({}).strict(),
    level: confirm, timing: PASEO_RESTART, keys: Object.values(ROLE_PROVIDERS).map(provider => ['providers', provider]), callers: ['launcher'],
    consumer: 'pi', records: 'move',
  },
  'pi.default-move': {
    title: "pi's default onto the main role", section: 'models', target: 'pi-settings', verb: 'config.apply',
    params: z.object({}).strict(),
    level: confirm, timing: NEW_PI_AGENTS, keys: [['defaultProvider'], ['defaultModel']], callers: ['launcher'],
    consumer: 'pi', records: 'move',
  },
  'paseo.profile-move': {
    title: 'A Paseo profile onto the coder role', section: 'models', target: 'paseo-config', verb: 'config.apply',
    params: z.object({ profile: z.string().regex(PROFILE_NAME) }).strict(),
    level: confirm, timing: NOW, keys: [['daemon', 'agentProfiles', { idParam: 'profile' }, 'model']], callers: ['launcher'],
    consumer: 'pi', records: 'move',
  },
  'gateway.restore-recorded': {
    title: 'Move a consumer back', section: 'models', target: { param: 'target' }, verb: 'config.apply',
    /**
     * One write per file. Model-dependent keys get `serving`, the direct values
     * for the model that's up; every other recorded key its value from before
     * the move, absence included. `keepRoleEntries` leaves pi's role providers
     * below the direct ones while a Paseo agent is pinned to them.
     */
    params: migrationPair.extend({
      serving: z.object({ provider: providerIdSchema, model: modelIdSchema, baseUrl: loopbackUrl.optional() }).strict().optional(),
      keepRoleEntries: z.boolean().default(false),
    }).strict().superRefine((params, context) => {
      if (!pairListed(params)) context.addIssue({ code: 'custom', path: ['target'], message: "not one of the consumer's files" });
      const needsServing = MODEL_DEPENDENT_TARGETS.includes(params.target) && params.consumer !== 'coder-mcp';
      if (needsServing !== (params.serving !== undefined)) {
        context.addIssue({ code: 'custom', path: ['serving'], message: needsServing ? 'the serving model is needed for this file' : 'this file has no model-dependent keys' });
      }
      if (params.target === 'hermes-config' && params.serving && !params.serving.baseUrl) {
        context.addIssue({ code: 'custom', path: ['serving', 'baseUrl'], message: "Hermes' model block needs its address" });
      }
      if (params.keepRoleEntries && params.target !== 'pi-models') {
        context.addIssue({ code: 'custom', path: ['keepRoleEntries'], message: "only pi's catalog keeps role entries" });
      }
    }),
    level: confirm, timing: BY_CONSUMER_TARGET, keys: 'recorded', callers: ['launcher'],
    records: 'restore',
  },
  'gateway.reapply-intended': {
    title: 'Put moved keys back on their intended values', section: 'checks', target: { param: 'target' }, verb: 'config.apply',
    /** An opaque intent id restores the latest ordinary write through its original operation and policy. */
    params: migrationPair.extend({ intentId: sha256Schema.optional() }).strict()
      .refine(pairListed, { path: ['target'], message: "not one of the consumer's files" })
      .refine(params => !params.intentId || params.consumer === 'hermes' && params.target === 'hermes-config',
        { path: ['intentId'], message: 'ordinary intent belongs to Hermes settings' }),
    level: confirm, timing: BY_CONSUMER_TARGET, keys: 'recorded', callers: ['launcher', 'server'],
  },

  'settings.accept-current': {
    title: 'Accept the current file as is', section: 'checks', target: { param: 'target' }, verb: 'settings.resolve',
    params: z.object({ change: z.string().regex(CHANGE_ID), target: targetIdSchema }).strict(),
    level: { fixed: 'pc-only' }, timing: NOW, keys: [], callers: ['server'],
  },
  'gateway.socket-recover': {
    title: 'Recover gateway role listeners', section: 'checks', target: 'gateway-role-map', verb: 'config.apply',
    params: z.object({}).strict(), level: confirm, timing: NOW, keys: [], callers: ['server'], recovery: true,
  },
  'hermes.drain-marker-remove': {
    title: 'Remove a leftover drain marker', section: 'checks', target: 'hermes-config', verb: 'config.apply',
    params: z.object({}).strict(), level: confirm, timing: NOW, keys: [], callers: ['server'], recovery: true,
  },

  // The supervisor's own records, after a verified change.
  'gateway.record-override': {
    title: 'Record a manual role change', section: 'models', target: 'gateway-state', verb: 'config.apply',
    params: z.object({ role: gatewayRoleSchema, backend: backendIdSchema.nullable() }).strict(),
    level: internal, timing: NOW, keys: [['state', 'overrides', { param: 'role' }]], callers: ['supervisor'],
  },
  'gateway.record-migration': {
    title: 'Record a move', section: 'models', target: 'gateway-state', verb: 'config.apply',
    params: migrationPair.extend({ change: z.enum(['move', 'intended', 'restore']) }).strict()
      .refine(pairListed, { path: ['target'], message: "not one of the consumer's files" }),
    level: internal, timing: NOW, keys: [['migration', 'consumers', { param: 'consumer' }, { param: 'target' }]], callers: ['supervisor'],
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof SETTINGS_OPERATIONS;
export const OPERATION_IDS = Object.keys(SETTINGS_OPERATIONS) as OperationId[];
export type OperationParams<Id extends OperationId> = z.output<(typeof SETTINGS_OPERATIONS)[Id]['params']>;

// ---- Reading the catalogue ---------------------------------------------------

export function operationSpec(id: string): OperationSpec | undefined {
  return Object.hasOwn(SETTINGS_OPERATIONS, id) ? SETTINGS_OPERATIONS[id as OperationId] : undefined;
}

export type ParsedOperation = { ok: true; operation: OperationId; spec: OperationSpec; params: Record<string, unknown> }
  | { ok: false; code: 'unknown_operation' | 'invalid_parameters' | 'not_permitted' };

/** Checks an operation request for a caller. Parameter errors name nothing but the code. */
export function parseOperation(operation: unknown, params: unknown, caller: OperationCaller): ParsedOperation {
  const spec = typeof operation === 'string' ? operationSpec(operation) : undefined;
  if (!spec) return { ok: false, code: 'unknown_operation' };
  if (!spec.callers.includes(caller)) return { ok: false, code: 'not_permitted' };
  const parsed = spec.params.safeParse(params ?? {});
  if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
  return { ok: true, operation: operation as OperationId, spec, params: parsed.data };
}

export const operationLevel = (spec: OperationSpec, params: Readonly<Record<string, unknown>>): SettingsLevel => levelFor(spec.level, params);
/** Undo uses an explicit restoration level or the operation's strictest level. */
export const undoLevel = (spec: OperationSpec): SettingsLevel => spec.undoLevel ?? strictestLevel(spec.level);

export function operationTarget(spec: OperationSpec, params: Readonly<Record<string, unknown>>): TargetId {
  return typeof spec.target === 'string' ? spec.target : params.target as TargetId;
}

function resolvedOperationTiming(spec: OperationSpec, params: Readonly<Record<string, unknown>>, changedKeys?: readonly KeyPath[]): Timing {
  let rule: Timing | KeyTimingRule;
  if ('byParams' in spec.timing) {
    const key = spec.timing.byParams.map(name => String(params[name])).join('/');
    const timing = Object.hasOwn(spec.timing.values, key) ? spec.timing.values[key] : undefined;
    if (!timing) throw new Error('No timing for these parameters.');
    rule = timing;
  } else rule = spec.timing;
  if (!('byKeys' in rule)) return rule;
  const parsed = z.array(keyPathSchema).min(1).max(MAX_OPERATION_KEYS).safeParse(changedKeys);
  if (!parsed.success) throw new Error('Changed keys are required for this timing.');
  const names = new Set(parsed.data.map(formatKeyPath));
  const covered = new Set<string>();
  const timing = rule.byKeys.flatMap(group => {
    const keys = [...new Set(parsed.data.filter(path => group.keys.some(pattern => pattern.length === path.length
      && pattern.every((segment, index) => segment === '*' || segment === path[index]))).map(formatKeyPath))];
    keys.forEach(key => covered.add(key));
    if (!keys.length) return [];
    return group.timing.flatMap(note => {
      const modelChanged = names.has('model.default') || names.has('model.provider');
      if (note.when === 'model-or-provider-changed' && !modelChanged) return [];
      if (note.when === 'base-url-only' && (modelChanged || !names.has('model.base_url'))) return [];
      const allowed = note.keys;
      const noteKeys = allowed ? keys.filter(key => allowed.includes(key)) : keys;
      return noteKeys.length ? [{ ...note, keys: noteKeys }] : [];
    });
  });
  if (covered.size !== names.size) throw new Error('No timing for a changed key.');
  return timing;
}

/** Recorded operations require the changed paths; their timing keys use the same public projection as change keys. */
export async function operationTiming(spec: OperationSpec, params: Readonly<Record<string, unknown>>, changedKeys?: readonly KeyPath[],
  context?: Parameters<typeof decideRead>[0]): Promise<Timing> {
  const timing = resolvedOperationTiming(spec, params, changedKeys);
  if (!changedKeys || !timing.some(note => note.keys)) return timing;
  const names = await publicKeyNames(operationTarget(spec, params), changedKeys, context);
  const projected = new Map(changedKeys.map((path, index) => [formatKeyPath(path), names[index]!]));
  return timing.map(note => note.keys ? { ...note, keys: note.keys.map(key => projected.get(key) ?? key) } : note);
}

/** The keys an operation touches, resolved from its parameters, or `recorded` (read from the migration record). */
export function operationKeys(spec: OperationSpec, params: Readonly<Record<string, unknown>>, current: unknown = {}): KeyPath[] | 'recorded' {
  if (spec.keys === 'recorded') return 'recorded';
  const paths: KeyPath[] = [];
  for (const template of spec.keys) {
    let partial: KeySegment[][] = [[]];
    for (const segment of template) {
      if (typeof segment === 'string') { partial = partial.map(path => [...path, segment]); continue; }
      if ('entriesIncluding' in segment) {
        partial = partial.flatMap(path => {
          let container = current;
          for (const key of path) {
            container = typeof key === 'string' && container !== null && typeof container === 'object' && Object.hasOwn(container, key)
              ? (container as Record<string, unknown>)[key] : undefined;
          }
          const names = container !== null && typeof container === 'object' && !Array.isArray(container) ? Object.keys(container) : [];
          return [...new Set([...segment.entriesIncluding, ...names])].filter(name => name !== '__proto__').map(name => [...path, name]);
        });
        continue;
      }
      const name = 'param' in segment ? segment.param : segment.idParam;
      const value = params[name];
      const values = Array.isArray(value) ? value : [value];
      if (!values.length || values.some(entry => typeof entry !== 'string' || entry === '')) throw new Error('A key parameter is missing.');
      partial = partial.flatMap(path => values.map(entry => [...path, 'param' in segment ? entry as string : { id: entry as string }]));
    }
    if (paths.length + partial.length > MAX_OPERATION_KEYS) throw new Error('Too many operation keys.');
    paths.push(...partial);
  }
  if (paths.some(path => !keyPathSchema.safeParse(path).success || formatKeyPath(path).length > 512)) throw new Error('Invalid operation keys.');
  if (spec.target === 'paseo-config') {
    const document = objectRecord(current);
    const agents = objectRecord(document.agents);
    const providers = { ...objectRecord(agents.providers) };
    for (const path of paths) {
      if (path[0] === 'agents' && path[1] === 'providers' && typeof path[2] === 'string' && !Object.hasOwn(providers, path[2])) {
        providers[path[2]] = {};
      }
    }
    // New provider entries expand both read fields; profiles and the routing note share the same result.
    readViewKeys(READ_VIEWS['paseo.agents'], { ...document, agents: { ...agents, providers } });
  }
  return paths;
}

/** Public change metadata defaults to digested identities; raw lookup paths come from operationKeys. */
export async function operationKeyNames(spec: OperationSpec, params: Readonly<Record<string, unknown>>, current?: unknown,
  context?: Parameters<typeof decideRead>[0]): Promise<string[] | 'recorded'> {
  const keys = operationKeys(spec, params, current);
  return keys === 'recorded' ? keys : publicKeyNames(operationTarget(spec, params), keys, context);
}

// ---- Read views (config.read) ------------------------------------------------

/**
 * What config.read may return, by view id: explicit fields only. `*` expands
 * entry names or array indices, never arbitrary child fields. Public values
 * must match their allowlisted schema; other values become digests off the PC.
 * Only allowlisted wildcard names remain literal off the PC; others become
 * stable SHA-256 identities, including in absent and names-only rows.
 * `order` lists an object's entry names in their order. `namesOnly` returns key
 * names without values.
 */
export interface ReadView {
  runtime?: boolean;
  /** Persisted text used for edits, independent of the consumer's effective values. */
  persisted?: boolean;
  target: TargetId;
  keys: readonly (readonly string[])[];
  order?: readonly (readonly string[])[];
  namesOnly?: boolean;
  /** Complete values are represented only by stable digests, including for PC callers. */
  comparisonDigests?: boolean;
  /** Recorded values can hold arbitrary nested credentials, even on the PC. */
  comparisonValues?: readonly string[];
  /** Only these exact field templates may return validated values to non-PC callers. */
  publicValues?: Readonly<Record<string, z.ZodType>>;
  /** Fixed names allowed at each wildcard prefix, such as `agents.providers.*`. */
  publicNames?: Readonly<Record<string, readonly string[]>>;
  /** Access required for unredacted values; sanitized reads need only settings scope. */
  level?: 'pc-only';
}

const objectRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Raw paths for internal lookup, including absent leaves. Public callers use readViewValues; expansion refuses overflow. */
export function readViewKeys(view: ReadView, current: unknown = {}): KeyPath[] {
  const paths: KeyPath[] = [];
  const expand = (template: readonly string[], value: unknown, path: KeySegment[]): void => {
    if (!template.length) {
      if (paths.length === MAX_OPERATION_KEYS) throw new Error('Too many read keys.');
      if (!keyPathSchema.safeParse(path).success || formatKeyPath(path).length > 512) throw new Error('Invalid read keys.');
      paths.push(path);
      return;
    }
    const [segment, ...rest] = template;
    if (segment === '*') {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => expand(rest, entry, [...path, index]));
      } else {
        for (const [key, entry] of Object.entries(objectRecord(value))) {
          if (key !== '__proto__' && !isSecretKeyName(key)) expand(rest, entry, [...path, key]);
        }
      }
    } else {
      const next = value !== null && typeof value === 'object' && Object.hasOwn(value, segment!)
        ? (value as Record<string, unknown>)[segment!] : undefined;
      expand(rest, next, [...path, segment!]);
    }
  };
  for (const template of view.keys) expand(template, current, []);
  return paths;
}

const hermesModelKeys = [
  ['model', 'provider'], ['model', 'default'], ['model', 'base_url'], ['model', 'reasoning_echo'],
  ['delegation', 'provider'], ['delegation', 'model'], ['delegation', 'fallback_providers'],
  ['delegation', 'max_concurrent_children'], ['delegation', 'max_iterations'],
  ['fallback_providers'], ['auxiliary', '*', 'provider'], ['auxiliary', '*', 'model'], ['providers', '*', 'base_url'],
  ['agent', 'tool_use_enforcement'], ['agent', 'execution_guidance'],
] as const;

const flag = z.boolean();
const count = z.number().int().nonnegative();
const tokens = z.number().int().positive().max(16_777_216);
const input = z.array(z.enum(['text', 'image'])).min(1).max(2);
const contractValues = { input, toolCalling: flag, thinkingLevels: flag, maxOutputTokens: tokens, advertisedContext: tokens };
const backendValues = { input, toolCalling: flag, thinkingLevels: flag, contextLength: tokens, maxOutputTokens: tokens,
  listenerUid: count.max(4_294_967_294) };
const fields = (prefix: readonly string[], names: readonly string[]): readonly string[][] => names.map(name => [...prefix, name]);
const publicFields = (prefix: string, schemas: Readonly<Record<string, z.ZodType>>): Record<string, z.ZodType> =>
  Object.fromEntries(Object.entries(schemas).map(([field, schema]) => [prefix + '.' + field, schema]));
const priceValues = Object.fromEntries(['inputPerMillionUsd', 'cacheReadPerMillionUsd', 'cacheWritePerMillionUsd', 'outputPerMillionUsd']
  .map(field => [field, z.number().nonnegative()]));
const migrationPrefix = ['migration', 'consumers', '*', '*'] as const;
const hermesPublicNames = { 'auxiliary.*': HERMES_HELPER_TASKS, 'providers.*': Object.values(ROLE_PROVIDERS) };

export const agentAvailabilitySchema = z.array(z.object({
  id: z.enum(['claude', 'codex', 'copilot']), installed: z.boolean().nullable(), authenticated: z.boolean().nullable(),
}).strict()).length(3).refine(agents => new Set(agents.map(agent => agent.id)).size === 3);

export const READ_VIEWS = {
  'wayroost.agents': { target: 'wayroost-settings', runtime: true, keys: [['agents']], publicValues: { agents: agentAvailabilitySchema } },
  'hermes.models': { target: 'hermes-config', keys: hermesModelKeys, level: 'pc-only', publicNames: hermesPublicNames, publicValues: {
    'model.reasoning_echo': z.union([flag, z.literal('auto')]),
    'agent.tool_use_enforcement': z.union([flag, z.literal('auto')]),
    'agent.execution_guidance': z.union([flag, z.literal('auto')]),
    'delegation.max_concurrent_children': count, 'delegation.max_iterations': count,
  } },
  'hermes.agents': { target: 'hermes-config', keys: [['agent', 'reasoning_effort'], ['display', 'personality'], ['agent', 'personalities', '*'], ['personalities', '*']], level: 'pc-only',
    publicValues: { 'agent.reasoning_effort': z.enum(REASONING_EFFORTS) } },
  'hermes.safety': {
    target: 'hermes-config',
    level: 'pc-only',
    keys: [['approvals', 'mode'], ['approvals', 'cron_mode'], ['command_allowlist'], ['skills', 'write_approval'], ['memory', 'write_approval']],
    publicValues: { 'approvals.mode': z.enum(APPROVAL_MODES), 'approvals.cron_mode': z.enum(['approve', 'deny']),
      'skills.write_approval': flag, 'memory.write_approval': flag },
  },
  'hermes.allowlist': { target: 'hermes-config', persisted: true, level: 'pc-only', keys: [['command_allowlist']] },
  'hermes.providers': { target: 'hermes-config', keys: [['providers', '*']], level: 'pc-only', comparisonDigests: true,
    publicNames: hermesPublicNames },
  'hermes.coder-mcp': { target: 'hermes-config', keys: [['mcp_servers', 'coder', 'command'], ['mcp_servers', 'coder', 'args']], level: 'pc-only' },
  'hermes.managed': { target: 'hermes-managed', keys: [...hermesModelKeys, ['providers', '*'],
    ['mcp_servers', 'coder', 'args'], ['agent', 'reasoning_effort'], ['display', 'personality'],
    ['agent', 'system_prompt'], ['approvals', 'mode'], ['approvals', 'cron_mode'], ['command_allowlist'],
    ['skills', 'write_approval'], ['memory', 'write_approval']], namesOnly: true, publicNames: hermesPublicNames },
  'windows-hermes.models': {
    target: 'windows-hermes',
    level: 'pc-only',
    keys: [['model', 'provider'], ['model', 'default'], ['model', 'base_url'], ['delegation', 'provider'], ['delegation', 'model'], ['agent', 'reasoning_effort']],
  },
  'pi.settings': { target: 'pi-settings', keys: [['defaultProvider'], ['defaultModel']], level: 'pc-only' },
  'pi.models': {
    target: 'pi-models',
    level: 'pc-only',
    keys: [['providers', '*', 'baseUrl'], ['providers', '*', 'api'], ...['id', 'contextWindow', 'maxTokens', 'input', 'reasoning']
      .map(field => ['providers', '*', 'models', '*', field] as const),
      ...fields(['providers', '*', 'models', '*', 'thinkingLevelMap'], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])],
    publicValues: publicFields('providers.*.models.*', { contextWindow: tokens, maxTokens: tokens, input, reasoning: flag }),
    publicNames: { 'providers.*': Object.values(ROLE_PROVIDERS) },
    order: [['providers']],
  },
  'pi.providers': { target: 'pi-models', keys: [['providers', '*']], level: 'pc-only', comparisonDigests: true,
    publicNames: { 'providers.*': Object.values(ROLE_PROVIDERS) } },
  'pi.mcp': { target: 'pi-mcp', keys: [['mcpServers', 'coder', 'command'], ['mcpServers', 'coder', 'args']], level: 'pc-only' },
  'paseo.agents': {
    target: 'paseo-config',
    level: 'pc-only',
    keys: [['agents', 'providers', '*', 'enabled'], ...fields(['agents', 'providers', '*', 'paseoTools'], ['enabled', 'disabledTools']), ...['id', 'name', 'provider', 'model']
      .map(field => ['daemon', 'agentProfiles', '*', field] as const), ['daemon', 'appendSystemPrompt']],
    publicValues: { 'agents.providers.*.enabled': flag, 'agents.providers.*.paseoTools.enabled': flag },
    publicNames: { 'agents.providers.*': [...PASEO_BUILTIN_PROVIDERS, ...PASEO_AGENT_PROVIDERS] },
  },
  'gateway.role-map': { target: 'gateway-role-map', level: 'pc-only', keys: [
    ...fields(['contracts', '*'], Object.keys(contractValues)),
    ...fields(['backends', '*'], ['baseUrl', 'servedName', 'provider', ...Object.keys(backendValues)]),
    ...fields(['backends', '*', 'price'], Object.keys(priceValues)),
    ...fields(['profiles', '*'], ['main', 'coder', 'fast']), ...fields(['roles'], ['main', 'coder', 'fast']),
  ], publicValues: { ...publicFields('contracts.*', contractValues), ...publicFields('backends.*', backendValues),
    ...publicFields('backends.*.price', priceValues) }, publicNames: { 'contracts.*': GATEWAY_ROLES } },
  'gateway.status': { target: 'gateway-role-map', runtime: true, level: 'pc-only', keys: [['roles'], ['draining']] },
  'gateway.listeners': { target: 'gateway-role-map', runtime: true, level: 'pc-only', keys: [['unit'], ['socketUnit'], ['roles']] },
  'gateway.state': { target: 'gateway-state', keys: [
    ...fields(['state'], ['version', 'profile', 'engine', 'broughtUpAt']),
    ...fields(['state', 'overrides', '*'], ['backend', 'at', 'by']), ['migration', 'version'],
    ...fields(migrationPrefix, ['moved', 'movedAt', 'restoredAt', 'preMoveBackupSha256', 'postMoveSha256']),
    ...fields([...migrationPrefix, 'keys', '*'], ['path', 'kind']),
    ...fields([...migrationPrefix, 'keys', '*', 'before'], ['exists', 'value']),
    ...fields([...migrationPrefix, 'keys', '*', 'intended'], ['exists', 'value']),
  ], level: 'pc-only', comparisonValues: ['migration.consumers.*.*.keys.*.before.value', 'migration.consumers.*.*.keys.*.intended.value'],
    publicValues: { 'state.version': z.literal(1), 'migration.version': z.literal(1),
    'state.overrides.*.by': z.enum(['wayroost', 'launcher']), 'migration.consumers.*.*.moved': flag,
    'migration.consumers.*.*.keys.*.kind': z.enum(['model-dependent', 'recorded', 'order']),
    'migration.consumers.*.*.keys.*.before.exists': flag, 'migration.consumers.*.*.keys.*.intended.exists': flag },
    publicNames: { 'state.overrides.*': GATEWAY_ROLES, 'migration.consumers.*': GATEWAY_CONSUMERS, 'migration.consumers.*.*': OWNER_FILE_TARGETS } },
  'claude.permissions': { target: 'claude-settings', keys: [['permissions', 'allow'], ['permissions', 'deny'], ['permissions', 'defaultMode']], level: 'pc-only' },
  'codex.approvals': { target: 'codex-config', keys: [['approval_policy'], ['sandbox_mode']], publicValues: {
    approval_policy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
    sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  } },
  'opencode.permissions': { target: 'opencode-config', keys: [['permission']], level: 'pc-only' },
  'wayroost.settings': { target: 'wayroost-settings', keys: [['safetyCommandsEnabled'], ['push', 'approvals'], ['push', 'cards'], ['quietHours'], ['rules']],
    publicValues: { safetyCommandsEnabled: flag, 'push.approvals': flag, 'push.cards': flag,
      quietHours: settingsNotificationsBodySchema.shape.quietHours, rules: settingsNotificationsBodySchema.shape.rules } },
} as const satisfies Record<string, ReadView>;
export type ReadViewId = keyof typeof READ_VIEWS;
export const READ_VIEW_IDS = Object.keys(READ_VIEWS) as ReadViewId[];
/** Unknown views fail closed; the request schema still refuses their ids. */
export function readViewLevel(id: string): SettingsLevel {
  if (!Object.hasOwn(READ_VIEWS, id)) return 'pc-only';
  return (READ_VIEWS[id as ReadViewId] as ReadView).level ?? 'anywhere';
}

export type ReadViewValue = { path: KeyPath; exists: false } | { path: KeyPath; exists: true; value?: SettingValue };

/** Strings use their UTF-8 bytes; other values use JSON bytes. Length counts those bytes before hashing. */
async function digestReadValue(value: SettingValue): Promise<RedactedSettingValue> {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return { sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), length: bytes.length };
}

/** Only literal catalogue fields and explicitly listed wildcard identities can remain public. */
async function publicKeyPaths(target: TargetId, paths: readonly KeyPath[], context: Parameters<typeof decideRead>[0] = { scopes: [] }): Promise<KeyPath[]> {
  if (paths.length > MAX_OPERATION_KEYS || paths.some(path => !keyPathSchema.safeParse(path).success || formatKeyPath(path).length > 512)) {
    throw new Error('Invalid public keys.');
  }
  const pcOnly = decideRead(context, 'pc-only').allowed;
  const views = (Object.values(READ_VIEWS) as ReadView[]).filter(view => view.target === target);
  const templates = [...views.flatMap(view => view.keys), ...(Object.values(SETTINGS_OPERATIONS) as OperationSpec[])
    .filter(spec => spec.target === target && spec.keys !== 'recorded')
    .flatMap(spec => (spec.keys as readonly KeyTemplate[]).map(key => key.map(segment => typeof segment === 'string' ? segment : '*')))];
  const identities = new Map<string, string>();
  const identity = async (name: string): Promise<string> => {
    if (!identities.has(name)) identities.set(name, `sha256:${(await digestReadValue(name)).sha256}`);
    return identities.get(name)!;
  };
  const projected: KeyPath[] = [];
  for (const path of paths) {
    const segments: KeySegment[] = [];
    for (const [index, segment] of path.entries()) {
      if (typeof segment === 'number') { segments.push(segment); continue; }
      if (typeof segment === 'object') { segments.push({ id: pcOnly ? segment.id : await identity(segment.id) }); continue; }
      const literal = templates.some(template => template.length > index && template[index] === segment
        && template.slice(0, index).every((part, offset) => part === '*' || part === path[offset]));
      const listed = views.some(view => view.keys.some(template => template.length > index && template[index] === '*'
        && template.slice(0, index).every((part, offset) => part === '*' || part === path[offset])
        && view.publicNames?.[template.slice(0, index + 1).join('.')]?.includes(segment)));
      segments.push(pcOnly || literal || listed ? segment : await identity(segment));
    }
    if (formatKeyPath(segments).length > 512) throw new Error('Invalid public keys.');
    projected.push(segments);
  }
  return projected;
}

/** Change results, recent changes and timing key lists use this projector, including resolved recorded paths. */
export async function publicKeyNames(target: TargetId, paths: readonly KeyPath[], context?: Parameters<typeof decideRead>[0]): Promise<string[]> {
  return (await publicKeyPaths(target, paths, context)).map(formatKeyPath);
}

/** Project only allowlisted fields; free text and unexpected value shapes fail closed to a digest off the PC. */
export async function readViewValues(id: ReadViewId, current: unknown, context: Parameters<typeof decideRead>[0]): Promise<ReadViewValue[]> {
  if (!Object.hasOwn(READ_VIEWS, id) || !decideRead(context).allowed) throw new Error('Read not permitted.');
  const view: ReadView = READ_VIEWS[id];
  const paths = readViewKeys(view, current);
  const pcOnly = decideRead(context, 'pc-only').allowed;
  const projectedPaths = await publicKeyPaths(view.target, paths, context);
  const values: ReadViewValue[] = [];
  for (const [pathIndex, path] of paths.entries()) {
    const template = view.keys.find(key => key.length === path.length && key.every((segment, index) => segment === '*' || segment === path[index]));
    if (!template) throw new Error('Invalid read keys.');
    const projectedPath = projectedPaths[pathIndex]!;
    let value: unknown = current;
    let exists = true;
    for (const segment of path) {
      if (typeof segment === 'object') throw new Error('Invalid read keys.');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) { exists = false; break; }
      value = (value as Record<string | number, unknown>)[segment];
    }
    if (!exists) { values.push({ path: projectedPath, exists: false }); continue; }
    if (id === 'hermes.agents' && path.includes('personalities')) {
      values.push({ path: projectedPath, exists: true }); continue;
    }
    if (view.namesOnly) { values.push({ path: projectedPath, exists: true }); continue; }
    const parsed = settingValueSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid read value.');
    const publicSchema = view.publicValues?.[template.join('.')];
    const publicValue = publicSchema?.safeParse(parsed.data);
    const comparison = view.comparisonDigests || view.comparisonValues?.includes(template.join('.'));
    const projected = comparison ? redactedSettingValueSchema.safeParse(parsed.data).success ? parsed.data : await digestReadValue(settingComparisonJson(parsed.data))
      : publicValue?.success ? publicValue.data as SettingValue
      : !publicSchema && pcOnly ? structuredClone(parsed.data) : await digestReadValue(parsed.data);
    values.push({ path: projectedPath, exists: true, value: projected });
  }
  return values;
}
