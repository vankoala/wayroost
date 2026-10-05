import { z } from 'zod';
import type { ServerEvent } from './protocol.js';
import { SPDX_LICENSE_IDS } from './spdx-license-ids.js';

export const ROLES_PACK_LIMITS = {
  text: 4096,
  markdown: 32_768,
  identifier: 128,
  path: 1024,
  signature: 16_384,
  items: 100,
  files: 256,
  document: 1_048_576,
} as const;

const knownEvents = {
  hello: true, source_status: true, conversation_upsert: true, conversation_removed: true, conversation_moved: true,
  items_upsert: true, items_replace: true, text_delta: true, approval_upsert: true, approval_removed: true,
  voice: true, schedules_changed: true, feed_upsert: true, feed_removed: true, skills_changed: true,
  power_status: true, power_action: true, power_line: true, pong: true, settings_changed: true, usage_changed: true,
  notification: true,
} satisfies Record<ServerEvent['type'], true>;

export const ROLES_PACK_EVENTS = Object.keys(knownEvents) as readonly (keyof typeof knownEvents)[];

const REFERENCE = /\$\{[A-Z_][A-Z0-9_]{0,63}\}/g;
const SECRET_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]{0,63}\}(?![\s\S])/;
const SK_KEY = /sk-(?:proj-[A-Za-z0-9_-]{20,}|(?!proj-)[A-Za-z0-9_-]{20,})/;
const KEY_PREFIX = /(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9]+|github_(?:pat)_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]+|glpat-[A-Za-z0-9_-]+|hf_[A-Za-z0-9]+)/;
const PEM_KEY = /-----BEGIN (?:[A-Z0-9]+ )*KEY-----/;

/** Whether text contains recognized key material outside secret references. */
export function hasSecret(value: string): boolean {
  const literal = value.replace(REFERENCE, ' ');
  return SK_KEY.test(literal) || PEM_KEY.test(literal) || KEY_PREFIX.test(literal);
}

function text(max: number = ROLES_PACK_LIMITS.text) {
  return z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`)
    .refine(value => value.trim().length > 0, 'must not be blank')
    .refine(value => !hasSecret(value), 'must use a ${NAME} reference instead of a secret literal');
}

const identifier = text(ROLES_PACK_LIMITS.identifier);
const slug = identifier.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug');
const markdown = text(ROLES_PACK_LIMITS.markdown);
const sha256 = text(64).regex(/^[a-fA-F0-9]{64}$/, 'must be 64 hex characters');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const semver = identifier.regex(SEMVER, 'must be a semantic version');

/** Whether text is a semantic version on its own, without the pack's other string rules. */
export function isSemanticVersion(value: string): boolean {
  return SEMVER.test(value);
}

const filePath = text(ROLES_PACK_LIMITS.path).refine(value =>
  !/[\\:\u0000-\u001f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'must be a relative file path without traversal');
const secretName = text(64).regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an uppercase secret name');
const secretReference = z.string({ error: 'must be a ${NAME} secret reference' })
  .max(67, 'must be at most 67 characters').regex(SECRET_REFERENCE, 'must be a ${NAME} secret reference');
const list = <T extends z.ZodType>(schema: T) => z.array(schema)
  .max(ROLES_PACK_LIMITS.items, `must contain at most ${ROLES_PACK_LIMITS.items} items`);

function map<K extends z.ZodString, V extends z.ZodType>(key: K, value: V, max: number = ROLES_PACK_LIMITS.items) {
  return z.preprocess((entries, ctx) => {
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      const keys = Object.keys(entries);
      if (keys.length > max) ctx.addIssue({ code: 'custom', message: `must contain at most ${max} entries` });
      if (Object.hasOwn(entries, '__proto__')) {
        ctx.addIssue({ code: 'custom', path: ['__proto__'], message: 'must not be a reserved map key' });
      }
    }
    return entries;
  }, z.record(key, value));
}

/** The harnesses a role pack is compiled for. */
export const PACK_HARNESSES = ['hermes', 'paseo', 'claude', 'codex'] as const;
export type PackHarness = (typeof PACK_HARNESSES)[number];

/** The access class used to check a role's declared tools. */
export const ROLE_CLASSES = ['web', 'file', 'private'] as const;
export type RoleClass = (typeof ROLE_CLASSES)[number];

/** Tool names that reach the open web, and the prefixes that mean the same. */
export const WEB_TOOLS = ['web_search', 'web_extract', 'web_fetch', 'web_open', 'http_get', 'http_post'] as const;
export const WEB_TOOL_PREFIXES = ['browser_'] as const;
/** Tool names that read or write files, memory or skills, and the prefixes that mean the same. */
export const FILE_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'search_files',
  'memory', 'memory_read', 'memory_write', 'memory_search',
] as const;
export const FILE_TOOL_PREFIXES = ['skill_', 'file_', 'fs_', 'memory_'] as const;

/** Which side of the class rule a tool name falls on, or null when it falls on neither. */
export function toolAccess(name: string): 'web' | 'file' | null {
  if ((WEB_TOOLS as readonly string[]).includes(name) || WEB_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) return 'web';
  if ((FILE_TOOLS as readonly string[]).includes(name) || FILE_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) return 'file';
  return null;
}

/** Why a tool name does not fit the role's class, or null when it fits. A web role gets no
 *  file or memory tools; a file or private role gets no web tools. */
export function classToolConflict(roleClass: RoleClass, name: string): string | null {
  const access = toolAccess(name);
  if (access === null) return null;
  if (roleClass === 'web' && access === 'file') {
    return 'is a file or memory tool, which class does not allow';
  }
  if (roleClass !== 'web' && access === 'web') {
    return 'is a web tool, which class does not allow';
  }
  return null;
}

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function cronField(field: string, min: number, max: number, names: readonly string[] = []): boolean {
  const number = (part: string): number => {
    if (/^\d+$/.test(part)) return Number(part);
    const index = names.indexOf(part.toUpperCase());
    return index < 0 ? NaN : index + min;
  };
  return field.split(',').every(item => {
    const parts = item.split('/');
    if (parts.length > 2) return false;
    const [base, step] = parts;
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > max - min + 1)) return false;
    if (base === '*') return true;
    const range = base!.split('-');
    if (range.length > 2) return false;
    const start = number(range[0]!);
    const end = range.length === 2 ? number(range[1]!) : start;
    return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
  });
}

/** Five-field cron: lists, ranges, steps, and named months or weekdays. */
function isCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && cronField(fields[0]!, 0, 59) && cronField(fields[1]!, 0, 23) &&
    cronField(fields[2]!, 1, 31) && cronField(fields[3]!, 1, 12, months) && cronField(fields[4]!, 0, 7, weekdays);
}

const harnessText = z.object({
  hermes: markdown.optional(), paseo: markdown.optional(), claude: markdown.optional(), codex: markdown.optional(),
}).strict();
/** What one harness's compiled prompt costs the role that runs on it. */
const measuredEntry = z.object({
  words: z.number().finite().int().nonnegative().max(10_000_000),
  tokens: z.number().finite().int().nonnegative().max(20_000_000),
}).strict();
const measuredLoad = z.object({
  hermes: measuredEntry.optional(), paseo: measuredEntry.optional(), claude: measuredEntry.optional(), codex: measuredEntry.optional(),
}).strict();
/** Where a role's updates come from: a channel, or one pinned version. */
const updatesChannel = z.union([z.enum(['stable', 'preview']), z.object({ pin: semver }).strict()],
  { error: 'must be "stable", "preview" or { pin: "<version>" }' });

const trimSubject = z.string().min(1, 'must not be empty')
  .max('skill:'.length + ROLES_PACK_LIMITS.identifier + 1 + ROLES_PACK_LIMITS.path)
  .superRefine((subject, ctx) => {
    const check = (schema: z.ZodType<string>, value: string) => {
      const result = schema.safeParse(value);
      if (!result.success) {
        for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message });
      }
    };
    if (subject.startsWith('skill:') || subject.startsWith('role:')) {
      const value = subject.slice(subject.indexOf(':') + 1);
      const slash = value.indexOf('/');
      check(slug, slash < 0 ? value : value.slice(0, slash));
      if (subject.startsWith('role:')) check(z.enum(PACK_HARNESSES), slash < 0 ? '' : value.slice(slash + 1));
      else if (slash >= 0) check(filePath, value.slice(slash + 1));
    } else if (subject.startsWith('budget:')) check(slug, subject.slice('budget:'.length));
    else check(identifier, subject);
  });

/** Evidence that shorter rules still behave: one per change that removes text. */
export const TrimRecordSchema = z.object({
  /** What got shorter: role:<id>/<harness>, skill:<id or bundled path> or budget:<id>. */
  subject: trimSubject,
  suite: text(256),
  models: z.array(text(256)).min(1, 'must name at least one model').max(ROLES_PACK_LIMITS.items, `must contain at most ${ROLES_PACK_LIMITS.items} items`),
  scoreBefore: z.number().finite().nonnegative(),
  scoreAfter: z.number().finite().nonnegative(),
  margin: z.number().finite().nonnegative(),
  askingFailuresChecked: z.boolean(),
  decliningFailuresChecked: z.boolean(),
  parseFailuresChecked: z.boolean(),
  ruleMapSha256: sha256,
}).strict();
export type TrimRecord = z.infer<typeof TrimRecordSchema>;

const provider = z.object({ provider: identifier, model: identifier }).strict();
const event = text(ROLES_PACK_LIMITS.identifier).refine(value =>
  (ROLES_PACK_EVENTS as readonly string[]).includes(value) || /^custom:[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value),
  'must be a known event or custom:<name>');

export const RolesPackSchema = z.object({
  identity: z.object({
    id: slug,
    name: text(256),
    face: text(ROLES_PACK_LIMITS.path).optional(),
    voice: identifier.optional(),
    version: semver,
    author: text(256),
    licence: map(filePath, z.string().max(ROLES_PACK_LIMITS.identifier, `must be at most ${ROLES_PACK_LIMITS.identifier} characters`)
      .refine(value => SPDX_LICENSE_IDS.has(value), 'must be an SPDX licence id'), ROLES_PACK_LIMITS.files),
    signature: text(ROLES_PACK_LIMITS.signature)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'must be detached base64 signature data').optional(),
  }).strict(),
  contract: markdown,
  updates: updatesChannel,
  callable: z.boolean(),
  class: z.enum(ROLE_CLASSES),
  instructions: z.object({ persona: markdown, overlays: harnessText.optional() }).strict(),
  skills: z.object({
    shared: list(z.object({ id: slug, version: semver, sha256 }).strict()),
    private: list(z.object({ path: filePath, sha256 }).strict()),
  }).strict(),
  connectors: z.object({
    mcpServers: list(z.object({
      registryId: identifier, version: semver,
      env: map(secretName, secretReference).optional(),
      headers: map(identifier, secretReference).optional(),
    }).strict()),
    secrets: map(secretName, secretReference).optional(),
  }).strict(),
  permissions: z.object({
    tools: list(z.object({ name: identifier, risk: z.enum(['low', 'standard', 'high']) }).strict()),
    sandbox: z.enum(['none', 'workspace', 'container']),
    limits: z.object({
      timeMinutes: z.number().finite().positive().max(525_600),
      costUsd: z.number().finite().nonnegative().max(1_000_000),
    }).strict(),
    readOnly: z.boolean(),
  }).strict(),
  triggers: z.object({
    schedules: list(text(256).refine(isCron, 'must be a valid five-field cron expression')),
    events: list(event),
  }).strict(),
  memory: z.object({ facts: list(z.object({ name: text(256), provenance: z.enum(['user-words', 'verified-fact']) }).strict()) }).strict(),
  model: z.object({
    declared: provider,
    testedWith: list(provider),
    evalRuns: list(z.object({ id: identifier, sha256 }).strict()),
  }).strict(),
  evals: z.object({
    tasks: list(z.object({ id: identifier, checks: list(text()) }).strict()),
    results: list(z.object({
      provider: identifier,
      model: identifier,
      passK: z.object({ k: z.number().int().min(1).max(10_000), rate: z.number().finite().min(0).max(1) }).strict(),
      costPerTaskUsd: z.number().finite().nonnegative().max(1_000_000),
    }).strict()),
  }).strict(),
  onboarding: z.object({ interviewQuestions: list(text()), conversationStarters: list(text()), disclaimer: text() }).strict(),
  providerIds: z.object({
    hermes: identifier.optional(), paseo: identifier.optional(), claude: identifier.optional(), codex: identifier.optional(),
  }).strict(),
  /** Written by the build: what each harness's compiled prompt measures. */
  measuredLoad: measuredLoad.optional(),
}).strict().superRefine((value, ctx) => {
  checkCredentialFields(value, ctx);
  checkToolClasses(value, ctx);
});

function isCredentialField(name: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  const words = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_-]/);
  return words.some(word => /^(?:keys?|tokens?|secrets?|passwords?|auth|authorization|authentication)$/i.test(word));
}

function checkCredentialFields(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkCredentialFields(item, ctx, [...path, index]));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const secretMap = path.length === 1 && path[0] === 'connectors' && key === 'secrets';
      const tokenCount = path.length === 2 && path[0] === 'measuredLoad' &&
        PACK_HARNESSES.some(harness => harness === path[1]) && key === 'tokens';
      if (isCredentialField(key) && !secretMap && !tokenCount) {
        if (typeof item !== 'string' || !SECRET_REFERENCE.test(item)) {
          ctx.addIssue({ code: 'custom', path: [...path, key], message: 'must be a ${NAME} secret reference' });
        }
      } else {
        checkCredentialFields(item, ctx, [...path, key]);
      }
    }
  }
}

function checkToolClasses(value: { class: RoleClass; permissions: { tools: Array<{ name: string }> } }, ctx: z.RefinementCtx): void {
  value.permissions.tools.forEach((tool, index) => {
    const conflict = classToolConflict(value.class, tool.name);
    if (conflict) ctx.addIssue({ code: 'custom', path: ['permissions', 'tools', index, 'name'], message: conflict });
  });
}

export type RolesPack = z.infer<typeof RolesPackSchema>;

export class RolesPackError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(issues.join('\n'));
    this.name = 'RolesPackError';
  }
}

function pathName(path: readonly PropertyKey[]): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`;
    const key = hasSecret(String(part)) ? '<secret>' : String(part);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${result}${result ? '.' : ''}${key}` :
      `${result}[${JSON.stringify(key)}]`;
  }, '') || 'rolesPack';
}

function issueText(issue: z.core.$ZodIssue): string {
  // Invalid record keys carry their string validation inside the record issue.
  if (issue.code === 'invalid_key') {
    return issue.issues.map(inner => `${pathName(issue.path)} ${inner.message}`).join('\n');
  }
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map(key => `${pathName([...issue.path, key])} is an unknown field`).join('\n');
  }
  return `${pathName(issue.path)} ${issue.message}`;
}

/** Returns a validated copy, or throws an error containing paths and explanations. */
export function validateRolesPack(obj: unknown): RolesPack {
  const result = RolesPackSchema.safeParse(obj);
  if (!result.success) throw new RolesPackError(result.error.issues.map(issueText));
  return result.data;
}

export function parseRolesPack(text: string): RolesPack {
  if (typeof text !== 'string') throw new RolesPackError(['rolesPack must be JSON text']);
  if (text.length > ROLES_PACK_LIMITS.document) {
    throw new RolesPackError([`rolesPack must be at most ${ROLES_PACK_LIMITS.document} characters`]);
  }
  let obj: unknown;
  try { obj = JSON.parse(text); }
  catch { throw new RolesPackError(['rolesPack must contain valid JSON']); }
  return validateRolesPack(obj);
}
