import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ServerEvent } from '../../shared/protocol.js';
import {
  parseRolesPack, validateRolesPack, RolesPackSchema, RolesPackError, ROLES_PACK_EVENTS, ROLES_PACK_LIMITS,
  type RolesPack,
} from '../../shared/roles-pack.js';
import { SPDX_LICENSE_IDS } from '../../shared/spdx-license-ids.js';

const exampleText = readFileSync(new URL('../../docs/roles-pack.example.json', import.meta.url), 'utf8');
const example = JSON.parse(exampleText) as RolesPack;
type Path = Array<string | number>;

const providerKeys = [
  'sk_live_' + 'fakekey', 'sk_test_' + 'fakekey', 'rk_live_' + 'fakekey', 'rk_test_' + 'fakekey',
  'ghp_' + 'fakekey', 'gho_' + 'fakekey', 'ghu_' + 'fakekey', 'ghs_' + 'fakekey', 'ghr_' + 'fakekey',
  ['github', 'pat', 'fakekey'].join('_'), ...['b', 'a', 'p'].map(kind => `xox${kind}-fake-key`),
  'xoxr-' + 'fake-key', 'xoxs-' + 'fake-key', 'AKIA' + '0'.repeat(16), 'ASIA' + '0'.repeat(16),
  'AIza' + 'fakekey', 'glpat-' + 'fakekey', 'hf_' + 'fakekey',
];

function changed(path: Path, value: unknown): unknown {
  const copy: unknown = structuredClone(example);
  let parent = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
  return copy;
}

function strings(value: unknown, path: Path = []): Array<{ path: Path; value: string }> {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, [...path, index]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, [...path, key]));
  return [];
}

function collections(value: unknown, path: Path = []): Array<{ path: Path; value: unknown[] }> {
  if (Array.isArray(value)) return [{ path, value }, ...value.flatMap((item, index) => collections(item, [...path, index]))];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => collections(item, [...path, key]));
  return [];
}

function stringLimit(path: Path): number | null {
  const name = String(path.at(-1));
  if (['risk', 'sandbox', 'provenance', 'class', 'updates'].includes(name)) return null;
  if (name === 'sha256') return 64;
  if (name === 'signature') return ROLES_PACK_LIMITS.signature;
  if (name === 'persona' || name === 'contract' || path.includes('overlays')) return ROLES_PACK_LIMITS.markdown;
  if (name === 'face' || name === 'path') return ROLES_PACK_LIMITS.path;
  if ((name === 'name' && (path[0] === 'identity' || path[0] === 'memory')) || name === 'author' || path.includes('schedules')) return 256;
  if (path.includes('secrets') || path.includes('env') || path.includes('headers')) return 67;
  if (path[0] === 'onboarding' || path.includes('checks')) return ROLES_PACK_LIMITS.text;
  return ROLES_PACK_LIMITS.identifier;
}

const invalidFields: Array<[Path, unknown]> = [
  [['identity', 'id'], 'Garden_Guide'],
  [['identity', 'name'], ''],
  [['identity', 'face'], 1],
  [['identity', 'voice'], false],
  [['identity', 'version'], '1.0'],
  [['identity', 'author'], '   '],
  [['identity', 'licence'], { 'persona.md': 'Made-Up-1.0' }],
  [['identity', 'licence'], { '../persona.md': 'MIT' }],
  [['identity', 'signature'], 'invalid!'],
  [['instructions', 'persona'], null],
  ...['hermes', 'paseo', 'claude', 'codex'].map(harness => [['instructions', 'overlays', harness], false] as [Path, unknown]),
  [['skills', 'shared', 0, 'id'], 'Uppercase'],
  [['skills', 'shared', 0, 'version'], '1.01.0'],
  [['skills', 'shared', 0, 'sha256'], 'z'.repeat(64)],
  [['skills', 'private', 0, 'path'], '/home/me/skill.md'],
  [['skills', 'private', 0, 'sha256'], 'f'.repeat(63)],
  [['connectors', 'mcpServers', 0, 'registryId'], ''],
  [['connectors', 'mcpServers', 0, 'version'], 'latest'],
  [['connectors', 'mcpServers', 0, 'env'], []],
  [['connectors', 'mcpServers', 0, 'headers'], null],
  [['connectors', 'secrets'], { WEATHER_API_KEY: 'literal-password' }],
  [['connectors', 'secrets'], { 'bad-name': '${WEATHER_API_KEY}' }],
  [['permissions', 'tools', 0, 'name'], 10],
  [['permissions', 'tools', 0, 'risk'], 'medium'],
  [['permissions', 'sandbox'], 'host'],
  [['permissions', 'limits', 'timeMinutes'], 0],
  [['permissions', 'limits', 'costUsd'], -1],
  [['permissions', 'readOnly'], 'true'],
  [['triggers', 'schedules', 0], '60 * * * *'],
  [['triggers', 'events', 0], 'unknown_event'],
  [['memory', 'facts', 0, 'name'], ''],
  [['memory', 'facts', 0, 'provenance'], 'guessed'],
  [['model', 'declared', 'provider'], false],
  [['model', 'declared', 'model'], ''],
  [['model', 'testedWith', 0, 'provider'], ''],
  [['model', 'testedWith', 0, 'model'], 1],
  [['model', 'evalRuns', 0, 'id'], ''],
  [['model', 'evalRuns', 0, 'sha256'], 'a'.repeat(65)],
  [['evals', 'tasks', 0, 'id'], ''],
  [['evals', 'tasks', 0, 'checks', 0], false],
  [['evals', 'results', 0, 'provider'], ''],
  [['evals', 'results', 0, 'model'], ''],
  [['evals', 'results', 0, 'passK', 'k'], 1.5],
  [['evals', 'results', 0, 'passK', 'rate'], 1.1],
  [['evals', 'results', 0, 'costPerTaskUsd'], -0.1],
  [['onboarding', 'interviewQuestions', 0], ''],
  [['onboarding', 'conversationStarters', 0], null],
  [['onboarding', 'disclaimer'], []],
  ...['hermes', 'paseo', 'claude', 'codex'].map(harness => [['providerIds', harness], false] as [Path, unknown]),
];

describe('roles pack', () => {
  it('parses the complete example through the exported schema and helpers', () => {
    expect(RolesPackSchema.parse(example)).toEqual(example);
    expect(validateRolesPack(example)).toEqual(example);
    expect(parseRolesPack(exampleText)).toEqual(example);
    expect(validateRolesPack(example)).not.toBe(example);
  });

  it('round trips through JSON without changing any fields', () => {
    const first = parseRolesPack(exampleText);
    expect(parseRolesPack(JSON.stringify(first))).toEqual(first);
  });

  it('rejects a licence key that would be dropped during parsing', () => {
    const licence = JSON.parse('{"__proto__":"MIT"}') as Record<string, string>;
    const pack = changed(['identity', 'licence'], licence);
    expect(() => validateRolesPack(pack)).toThrow('identity.licence.__proto__ must not be a reserved map key');
    expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('reserved map key');
    expect(RolesPackSchema.safeParse(pack).success).toBe(false);
  });

  it('preserves accepted licence keys that also name object properties', () => {
    const licence = { constructor: 'MIT', prototype: 'Apache-2.0', toString: 'MIT' };
    const pack = changed(['identity', 'licence'], licence);
    expect(validateRolesPack(pack).identity.licence).toEqual(licence);
    expect(parseRolesPack(JSON.stringify(validateRolesPack(pack)))).toEqual(pack);
  });

  it('allows omitted optional metadata, empty collections, and a read-only role', () => {
    const pack = structuredClone(example);
    delete pack.identity.face; delete pack.identity.voice; delete pack.identity.signature;
    delete pack.instructions.overlays; delete pack.connectors.secrets;
    pack.skills = { shared: [], private: [] };
    pack.connectors.mcpServers = [];
    pack.permissions = { tools: [], sandbox: 'none', limits: { timeMinutes: 0.5, costUsd: 0 }, readOnly: true };
    pack.triggers = { schedules: [], events: [] }; pack.memory.facts = [];
    pack.model.testedWith = []; pack.model.evalRuns = [];
    pack.evals = { tasks: [], results: [] };
    pack.onboarding.interviewQuestions = []; pack.onboarding.conversationStarters = [];
    pack.providerIds = {};
    expect(validateRolesPack(pack)).toEqual(pack);
  });

  it.each(invalidFields)('rejects an invalid field at %j', (path, value) => {
    expect(RolesPackSchema.safeParse(changed(path, value)).success).toBe(false);
    expect(() => validateRolesPack(changed(path, value))).toThrow(RolesPackError);
  });

  // A build writes the measured load; a pack author may leave it out.
  it.each(Object.keys(example).filter(key => key !== 'measuredLoad'))('requires the %s section', key => {
    const pack = { ...example } as Record<string, unknown>;
    delete pack[key];
    expect(() => validateRolesPack(pack)).toThrow(key);
  });

  it.each([undefined, null, [], true, 10, 'garden-guide'])('rejects a non-object pack: %j', value => {
    expect(() => validateRolesPack(value)).toThrow(RolesPackError);
  });

  it('rejects unknown top-level and nested fields instead of dropping them', () => {
    expect(() => validateRolesPack({ ...example, unexpected: true })).toThrow('unexpected is an unknown field');
    expect(() => validateRolesPack(changed(['identity', 'unexpected'], true))).toThrow('identity.unexpected is an unknown field');
    expect(() => validateRolesPack(changed(['instructions', 'overlays', 'unexpected'], 'text'))).toThrow('instructions.overlays.unexpected is an unknown field');
    expect(() => validateRolesPack(changed(['providerIds', 'unexpected'], 'demo-id'))).toThrow('providerIds.unexpected is an unknown field');
  });

  it('reports array indices, nested properties and map paths', () => {
    const pack = structuredClone(example);
    pack.skills.shared = Array.from({ length: 3 }, () => structuredClone(example.skills.shared[0]!));
    pack.skills.shared[2]!.sha256 = 'no';
    expect(() => validateRolesPack(pack)).toThrow('skills.shared[2].sha256 must be 64 hex characters');
    expect(() => validateRolesPack(changed(['evals', 'tasks', 0, 'checks', 0], ''))).toThrow('evals.tasks[0].checks[0] must not be empty');
    expect(() => validateRolesPack(changed(['identity', 'licence'], { 'persona.md': 'Made-Up-1.0' })))
      .toThrow('identity.licence["persona.md"] must be an SPDX licence id');
  });

  it('reports malformed JSON without echoing the input', () => {
    for (const input of ['', '{', '{"name":', 'undefined']) {
      expect(() => parseRolesPack(input)).toThrow('rolesPack must contain valid JSON');
    }
    expect(() => parseRolesPack(undefined as unknown as string)).toThrow('rolesPack must be JSON text');
  });

  it.each(['MIT', 'Apache-2.0', 'GPL-3.0-only', 'BSD-3-Clause', 'CC-BY-4.0', '0BSD', 'BlueOak-1.0.0'])('accepts the SPDX id %s', id => {
    expect(validateRolesPack(changed(['identity', 'licence'], { 'persona.md': id })).identity.licence['persona.md']).toBe(id);
  });

  it('accepts every SPDX identifier in the pinned list', () => {
    for (const id of SPDX_LICENSE_IDS) {
      expect(RolesPackSchema.safeParse(changed(['identity', 'licence'], { 'persona.md': id })).success, id).toBe(true);
    }
  });

  it.each(['../skill.md', 'skills/../skill.md', './skill.md', 'skills//skill.md', 'C:\\skill.md', 'skills\\skill.md', 'skill\u0000.md'])
    ('rejects unsafe bundled file paths: %s', path => {
      expect(() => validateRolesPack(changed(['skills', 'private', 0, 'path'], path))).toThrow('relative file path');
    });

  it.each(['0.0.0', '1.2.3-alpha.1', '1.2.3+demo.01', '1.2.3-rc.1+build.5'])('accepts semantic version %s', version => {
    expect(validateRolesPack(changed(['identity', 'version'], version)).identity.version).toBe(version);
  });

  it.each(['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-', '1.2.3+', '1.2.3+build..1'])('rejects malformed semantic version %s', version => {
    expect(() => validateRolesPack(changed(['identity', 'version'], version))).toThrow('semantic version');
  });

  it.each(['low', 'standard', 'high'])('accepts tool risk %s', risk => {
    expect(validateRolesPack(changed(['permissions', 'tools', 0, 'risk'], risk)).permissions.tools[0]!.risk).toBe(risk);
  });

  it.each(['none', 'workspace', 'container'])('accepts sandbox %s', sandbox => {
    expect(validateRolesPack(changed(['permissions', 'sandbox'], sandbox)).permissions.sandbox).toBe(sandbox);
  });

  it.each([
    [['permissions', 'limits', 'timeMinutes'], Infinity], [['permissions', 'limits', 'timeMinutes'], -1],
    [['permissions', 'limits', 'timeMinutes'], 525_601], [['permissions', 'limits', 'costUsd'], NaN],
    [['permissions', 'limits', 'costUsd'], 1_000_001], [['evals', 'results', 0, 'passK', 'k'], 0],
    [['evals', 'results', 0, 'passK', 'k'], 10_001], [['evals', 'results', 0, 'passK', 'rate'], -0.01],
    [['evals', 'results', 0, 'passK', 'rate'], Infinity], [['evals', 'results', 0, 'costPerTaskUsd'], NaN],
  ] as Array<[Path, unknown]>)('rejects invalid numeric limits at %j', (path, value) => {
    expect(() => validateRolesPack(changed(path, value))).toThrow(RolesPackError);
  });
});

describe('roles pack secrets', () => {
  const secret = 'sk-' + 'obviously-fake-key-material';
  const plainStrings = strings(example).filter(({ path }) => !['sha256', 'signature'].includes(String(path.at(-1))));

  it.each([
    [['identity', 'id'], 'task-planner'],
    [['identity', 'id'], 'autodesk-drafter'],
    [['identity', 'id'], 'repository-specific-agent-instruction-maintenance'],
    [['identity', 'id'], 'garden-'.repeat(18) + 'id'],
    [['identity', 'name'], 'repository-specific-agent-instruction-maintenance'],
    [['identity', 'name'], 'repositorySpecificAgentInstructionMaintenance'],
    [['identity', 'id'], 'repositoryspecificagentinstructionmaintenance'],
    [['identity', 'id'], 'a1'.repeat(64)],
    [['skills', 'shared', 0, 'id'], 'repositoryspecificagentinstructionmaintenance'],
    [['skills', 'shared', 0, 'id'], 'a1'.repeat(64)],
    [['providerIds', 'codex'], 'repositorySpecificAgentInstructionMaintenance'],
    [['permissions', 'tools', 0, 'name'], 'repositorySpecificAgentInstructionMaintenance'],
    [['skills', 'private', 0, 'path'], 'skills/repositorySpecificAgentInstructionMaintenance/SKILL.md'],
    [['identity', 'face'], 'images/repositorySpecificAgentInstructionMaintenance.png'],
    [['instructions', 'persona'], 'Use repositorySpecificAgentInstructionMaintenance for this repository.'],
    [['skills', 'shared', 0, 'id'], 'repository-specific-agent-instruction-maintenance'],
    [['skills', 'shared', 0, 'id'], 'garden-'.repeat(18) + 'id'],
    [['providerIds', 'codex'], 'repository_specific_instruction_maintenance'],
    [['providerIds', 'codex'], 'demo_'.repeat(12)],
    [['permissions', 'tools', 0, 'name'], 'repository_specific_instruction_maintenance'],
    [['skills', 'private', 0, 'path'], 'skills/repository-specific-agent-instruction-maintenance/SKILL.md'],
    [['instructions', 'persona'], 'Use repository-specific-agent-instruction-maintenance for this repository.'],
    [['skills', 'shared', 0, 'id'], 'asterisk-delimited'],
    [['providerIds', 'codex'], 'obelisk-guide'],
    [['identity', 'face'], 'images/task-planner.png'],
    [['skills', 'private', 0, 'path'], 'skills/task-planner/SKILL.md'],
    [['identity', 'face'], 'images/autodesk-drafter.png'],
    [['skills', 'private', 0, 'path'], 'skills/asterisk-delimited/SKILL.md'],
    [['instructions', 'persona'], '# Task planner\nUse a task-specific checklist.'],
    [['instructions', 'persona'], 'Use asterisk-delimited text with the autodesk-drafter role.'],
    [['onboarding', 'disclaimer'], 'Use a kiosk-guide, cornhusk-basket, and busk-schedule.'],
    [['instructions', 'overlays', 'codex'], 'Use a planning-checklist and ask-first prompts.'],
    [['onboarding', 'disclaimer'], 'Use a disk-based cache, desk-lamp, and risk-aware plan.'],
    [['onboarding', 'disclaimer'], 'Use a subtask-checklist2, multitask-checklist2, mask-filter, and dusk-timer.'],
  ] as Array<[Path, string]>)('preserves ordinary words in the string field %j', (path, value) => {
    const pack = changed(path, value);
    expect(RolesPackSchema.parse(pack)).toEqual(pack);
    expect(validateRolesPack(pack)).toEqual(pack);
    expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
  });

  it.each([
    'skills/task-planner/SKILL.md',
    'skills/autodesk-drafter/SKILL.md', 'asterisk-delimited.md',
    'skills/repository-specific-agent-instruction-maintenance/SKILL.md',
    'repository_specific_instruction_maintenance.md',
    'repositorySpecificAgentInstructionMaintenance.md',
    'repositoryspecificagentinstructionmaintenance.md',
  ])
    ('preserves ordinary words in file map keys and error paths: %s', path => {
      const pack = changed(['identity', 'licence'], { [path]: 'MIT' });
      expect(RolesPackSchema.parse(pack)).toEqual(pack);
      expect(validateRolesPack(pack)).toEqual(pack);
      expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
      expect(() => validateRolesPack(changed(['identity', 'licence'], { [path]: 'Made-Up-1.0' })))
        .toThrow(`identity.licence["${path}"] must be an SPDX licence id`);
    });

  it.each(plainStrings)('rejects key literals in the string field $path', ({ path }) => {
    expect(RolesPackSchema.safeParse(changed(path, secret)).success).toBe(false);
  });

  it.each([
    'repositorySpecificAgentInstructionMaintenance', 'a'.repeat(64), 'A'.repeat(50), 'a1'.repeat(64),
    'abcdef01'.repeat(8), 'ABCDEF01'.repeat(8), '01234567'.repeat(8),
    'ZmFr'.repeat(16) + 'ZQ==', 'ZmFr'.repeat(16), 'ZmFr/fake+'.repeat(6),
  ])('accepts long text in prose and map keys: %s', value => {
    const prosePaths: Path[] = [
      ['identity', 'name'], ['contract'], ['instructions', 'persona'], ['instructions', 'overlays', 'codex'], ['providerIds', 'codex'],
    ];
    for (const path of prosePaths) {
      const pack = changed(path, value);
      expect(RolesPackSchema.parse(pack)).toEqual(pack);
      expect(validateRolesPack(pack)).toEqual(pack);
      expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
    }
    for (const path of [['identity', 'licence'], ['connectors', 'mcpServers', 0, 'headers']] as Path[]) {
      const pack = changed(path, { [value]: path[0] === 'identity' ? 'MIT' : '${DEMO_VALUE}' });
      expect(RolesPackSchema.parse(pack)).toEqual(pack);
      expect(validateRolesPack(pack)).toEqual(pack);
      expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
    }
    try {
      validateRolesPack(changed(['identity', 'licence'], { [value]: 'Made-Up-1.0' }));
      expect.fail('Invalid licence was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(RolesPackError);
      expect((error as Error).message).toContain(value);
      expect((error as Error).message).not.toContain('<secret>');
    }
  });

  it.each(providerKeys)('rejects an embedded secret literal: %s', literal => {
    expect(() => validateRolesPack(changed(['instructions', 'persona'], `Use this value: ${literal}.`))).toThrow('secret literal');
  });

  it('accepts ordinary encoded text after an equals sign or inside a URL', () => {
    const literal = '01234567'.repeat(8);
    for (const value of [`key=${literal}`, `https://example.com/?token=${literal}`, `https://example.com/${literal}`]) {
      const pack = changed(['instructions', 'persona'], value);
      expect(validateRolesPack(pack)).toEqual(pack);
      expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
    }
  });

  it.each(providerKeys)('rejects known key prefixes following alphanumeric text: %s', literal => {
    const value = `x${literal}`;
    expect(value.length).toBeLessThan(40);
    for (const path of [['identity', 'name'], ['instructions', 'persona'], ['providerIds', 'codex']] as Path[]) {
      const pack = changed(path, value);
      expect(RolesPackSchema.safeParse(pack).success).toBe(false);
      expect(() => validateRolesPack(pack)).toThrow('secret literal');
      expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('secret literal');
    }
    const pack = changed(['identity', 'licence'], { [value]: 'MIT' });
    expect(RolesPackSchema.safeParse(pack).success).toBe(false);
    expect(() => validateRolesPack(pack)).toThrow('secret literal');
    expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('secret literal');
  });

  it.each([
    'sk-' + 'abcdefghijklmnopqrstuvwxyz',
    'sk-' + 'a'.repeat(20),
    'sk-' + 'A'.repeat(20),
    'sk-' + '0'.repeat(20),
    'sk-' + '_'.repeat(20),
    'sk-' + '-'.repeat(20),
    'sk-' + 'fake-key_material-012',
    'sk-' + 'FAKEkey0123456789abcde',
    'sk-' + 'proj-' + 'a'.repeat(20),
    'sk-' + 'proj-' + 'fake-key_material-012',
  ])('rejects credential-shaped sk keys inside longer words: %s', literal => {
    for (const value of [`prefix${literal}`, `task-${literal}`, `https://example.com/?key=prefix${literal}`]) {
      for (const path of [['identity', 'name'], ['instructions', 'persona'], ['providerIds', 'codex']] as Path[]) {
        const pack = changed(path, value);
        expect(RolesPackSchema.safeParse(pack).success).toBe(false);
        expect(() => validateRolesPack(pack)).toThrow('secret literal');
        expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('secret literal');
      }
      const pack = changed(['identity', 'licence'], { [value]: 'MIT' });
      expect(RolesPackSchema.safeParse(pack).success).toBe(false);
      expect(() => validateRolesPack(pack)).toThrow('secret literal');
      expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('secret literal');
    }
  });

  it.each([
    'ask-' + 'FAKEkey0123456789abcde', 'task-proj-' + 'FAKEkey0123456789abcde',
    'autodesk-' + 'FAKEkey0123456789abcde', 'asterisk-proj-' + 'FAKEkey0123456789abcde',
    'Ask-' + 'FAKEkey0123456789abcde', 'task-' + 'FAKEKEY0123456789ABCD',
    'task-proj-' + 'fakekey0123456789abcde',
    'task-' + 'a'.repeat(20), 'asterisk-' + 'a'.repeat(20),
  ])('rejects credential payloads after word-like prefixes: %s', literal => {
    for (const path of [['identity', 'name'], ['instructions', 'persona'], ['providerIds', 'codex']] as Path[]) {
      const pack = changed(path, literal);
      expect(RolesPackSchema.safeParse(pack).success).toBe(false);
      expect(() => validateRolesPack(pack)).toThrow('secret literal');
      expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('secret literal');
    }
    for (const licence of ['MIT', 'Made-Up-1.0']) {
      const pack = changed(['identity', 'licence'], { [literal]: licence });
      expect(RolesPackSchema.safeParse(pack).success).toBe(false);
      for (const validate of [() => validateRolesPack(pack), () => parseRolesPack(JSON.stringify(pack))]) {
        expect(validate).toThrow('secret literal');
        try {
          validate();
          expect.fail('Secret-looking map key was accepted');
        } catch (error) {
          expect(error).toBeInstanceOf(RolesPackError);
          expect((error as RolesPackError).issues.join('\n')).toContain('identity.licence["<secret>"]');
          expect((error as Error).message).not.toContain(literal);
          expect((error as RolesPackError).issues.join('\n')).not.toContain(literal);
        }
      }
    }
  });

  it.each([
    'sk-', 'sk-' + 'fake-key', 'sk-' + 'abc', 'sk-' + 'a'.repeat(19), 'sk-' + 'proj-' + 'a'.repeat(19),
    'sk-' + 'a'.repeat(19) + '+' + 'a'.repeat(20), 'sk-' + 'a'.repeat(19) + '/' + 'a'.repeat(20),
  ])
    ('accepts sk text below the payload threshold: %s', literal => {
      for (const value of [literal, `Key: ${literal}.`, `key=${literal}`, `https://example.com/${literal}`]) {
        const pack = changed(['instructions', 'persona'], value);
        expect(validateRolesPack(pack)).toEqual(pack);
        expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
      }
      const filename = `${literal}.md`;
      expect(validateRolesPack(changed(['identity', 'licence'], { [filename]: 'MIT' })).identity.licence).toEqual({ [filename]: 'MIT' });
      expect(() => validateRolesPack(changed(['identity', 'licence'], { [filename]: 'Made-Up-1.0' })))
        .toThrow(`identity.licence["${filename}"] must be an SPDX licence id`);
    });

  it('rejects embedded key prefixes in detached signature data', () => {
    expect(() => validateRolesPack(changed(['identity', 'signature'], 'x' + 'AKIA' + '0'.repeat(16) + 'AAA')))
      .toThrow('secret literal');
  });

  it('accepts long uppercase names in secret and environment maps', () => {
    for (const name of ['A'.repeat(50), 'A'.repeat(64)]) {
      for (const path of [['connectors', 'secrets'], ['connectors', 'mcpServers', 0, 'env']] as Path[]) {
        const pack = changed(path, { [name]: '${WEATHER_API_KEY}' });
        expect(validateRolesPack(pack)).toEqual(pack);
        expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
        expect(() => validateRolesPack(changed(path, { [name]: 'ordinary text' })))
          .toThrow(name + ' must be a ${NAME} secret reference');
      }
    }
  });

  it.each(['xsk-' + 'a'.repeat(20), 'prefixsk-' + 'abcdefghijklmnopqrstuvwxyz'])
    ('redacts secret-looking map keys in error paths: %s', literal => {
      try {
        validateRolesPack(changed(['identity', 'licence'], { [literal]: 'MIT' }));
        expect.fail('Secret-looking map key was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(RolesPackError);
        expect((error as Error).message).toContain('identity.licence["<secret>"]');
        expect((error as Error).message).not.toContain(literal);
      }
    });

  it('accepts references in secret maps and prose, including long reference names', () => {
    const name = 'A'.repeat(64);
    const pack = structuredClone(example);
    pack.connectors.secrets = { WEATHER_API_KEY: '${' + name + '}' };
    pack.instructions.persona = 'Use ${WEATHER_API_KEY} and ${' + name + '} to retrieve the weather.';
    expect(validateRolesPack(pack)).toEqual(pack);
  });

  it('treats reference names as references without joining adjacent text', () => {
    const pack = structuredClone(example);
    const reference = '${AKIA' + 'A'.repeat(16) + '}';
    pack.connectors.secrets = { WEATHER_API_KEY: reference };
    pack.instructions.persona = reference + ' sk-' + 'a'.repeat(10) + '${NAME}' + 'a'.repeat(10) + ' gh${NAME}p_fakekey';
    expect(validateRolesPack(pack)).toEqual(pack);
    expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
  });

  it.each(['${lowercase}', '${NAME} suffix', '$NAME', '${}', '${NAME-NAME}', 'password', 'https://example.com'])('requires complete secret references: %s', value => {
    expect(() => validateRolesPack(changed(['connectors', 'secrets', 'WEATHER_API_KEY'], value))).toThrow('secret reference');
  });

  it('keeps the digest and detached signature formats for encoded data', () => {
    const pack = structuredClone(example);
    pack.skills.shared[0]!.sha256 = 'abcdef01'.repeat(8);
    pack.skills.private[0]!.sha256 = 'ABCDEF01'.repeat(8);
    pack.model.evalRuns[0]!.sha256 = '01234567'.repeat(8);
    pack.identity.signature = 'ZmFr'.repeat(20);
    expect(validateRolesPack(pack)).toEqual(pack);
    expect(validateRolesPack(changed(['identity', 'name'], pack.skills.shared[0]!.sha256)).identity.name)
      .toBe(pack.skills.shared[0]!.sha256);
  });

  it.each(['A', 'AAA', 'A===', '=AAA', 'AAAA\nAAAA', '____'])('rejects malformed base64 signatures: %s', signature => {
    expect(() => validateRolesPack(changed(['identity', 'signature'], signature))).toThrow(RolesPackError);
  });
});

describe('roles pack credential fields', () => {
  const plainPaths: Path[] = [['identity', 'name'], ['instructions', 'persona'], ['providerIds', 'codex']];
  function accepts(pack: unknown) {
    expect(RolesPackSchema.parse(pack)).toEqual(pack);
    expect(validateRolesPack(pack)).toEqual(pack);
    expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
  }

  function rejects(pack: unknown, message: string) {
    expect(RolesPackSchema.safeParse(pack).success).toBe(false);
    expect(() => validateRolesPack(pack)).toThrow(message);
    expect(() => parseRolesPack(JSON.stringify(pack))).toThrow(message);
  }

  const secretMaps: Path[] = [
    ['connectors', 'secrets'], ['connectors', 'mcpServers', 0, 'env'], ['connectors', 'mcpServers', 0, 'headers'],
  ];

  it.each(secretMaps.map(path => ({ path })))('accepts only references in connector map $path', ({ path }) => {
    accepts(changed(path, { DEMO_VALUE: '${DEMO_VALUE}', OTHER_VALUE: '${' + 'A'.repeat(64) + '}' }));
    for (const value of ['ordinary text', 'sk-' + 'fake', 'a'.repeat(64), '', 123, false, null, {}, []]) {
      rejects(changed(path, { DEMO_VALUE: value }), 'secret reference');
    }
  });

  it.each(['${lowercase}', '${NAME} suffix', 'prefix ${NAME}', '$NAME', '${}', '${NAME-NAME}', '${NAME}\n', '${NAME}\r\n', '${' + 'A'.repeat(65) + '}'])
    ('requires a complete reference in every secret-bearing map: %s', value => {
      for (const path of secretMaps) rejects(changed(path, { DEMO_VALUE: value }), 'secret reference');
    });

  it('requires a reference for every environment variable and header regardless of name', () => {
    rejects(changed(['connectors', 'mcpServers', 0, 'env'], { MODE: 'development' }), 'env.MODE must be a ${NAME} secret reference');
    rejects(changed(['connectors', 'mcpServers', 0, 'headers'], { 'User-Agent': 'garden-guide' }), 'headers["User-Agent"] must be a ${NAME} secret reference');
    accepts(changed(['connectors', 'mcpServers', 0, 'headers'], { Authorization: '${AUTH_TOKEN}', 'User-Agent': '${USER_AGENT}' }));
  });

  it.each([
    'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'auth',
    'apiKey', 'API_KEY', 'accessToken', 'client_secret', 'Authorization', 'authentication', 'APIKey', 'AuthToken',
  ])
    ('requires references for credential-named fields: %s', name => {
      rejects(changed(['identity', 'licence'], { [name]: 'MIT' }), `identity.licence.${name} must be a \${NAME} secret reference`);
      rejects(changed(['identity', name], 'ordinary text'), 'unknown field');
      accepts(changed(['connectors', 'mcpServers', 0, 'headers'], { [name]: '${DEMO_VALUE}' }));
      rejects(changed(['connectors', 'mcpServers', 0, 'headers'], { [name]: 'ordinary text' }), 'secret reference');
      for (const path of [['connectors', 'secrets'], ['connectors', 'mcpServers', 0, 'env']] as Path[]) {
        const secretName = name.toUpperCase();
        accepts(changed(path, { [secretName]: '${DEMO_VALUE}' }));
        rejects(changed(path, { [secretName]: 'ordinary text' }), 'secret reference');
      }
    });

  it.each(['api-key', 'sk' + '-fake-key'])('requires a reference without redacting the ordinary field name %s', name => {
    rejects(changed(['identity', 'licence'], { [name]: 'MIT' }), `identity.licence["${name}"] must be a \${NAME} secret reference`);
  });

  it('allows credential words in field values and file names', () => {
    accepts(changed(['identity', 'author'], 'Example Author'));
    accepts(changed(['identity', 'name'], 'Token planning and password guidance'));
    accepts(changed(['identity', 'licence'], { 'skills/token/SKILL.md': 'MIT', 'auth.md': 'MIT', 'api-key.md': 'MIT' }));
  });

  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PUBLIC KEY'])
    ('rejects a PEM %s block', label => {
      const pem = `-----BEGIN ${label}-----\nZmFrZQ==\n-----END ${label}-----`;
      for (const path of plainPaths) rejects(changed(path, pem), 'secret literal');
      rejects(changed(['identity', 'licence'], { [pem]: 'MIT' }), 'secret literal');
      expect(() => validateRolesPack(changed(['identity', 'licence'], { [pem]: 'MIT' })))
        .toThrow('identity.licence["<secret>"]');
    });

  it('accepts PEM certificates that do not contain keys', () => {
    accepts(changed(['instructions', 'persona'], '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----'));
  });

  it.each(providerKeys)('rejects and redacts provider-shaped credentials: %s', literal => {
    for (const path of [['instructions', 'persona'], ['identity', 'name'], ['providerIds', 'codex']] as Path[]) {
      rejects(changed(path, literal), 'secret literal');
    }
    for (const licence of ['MIT', 'Made-Up-1.0']) {
      const pack = changed(['identity', 'licence'], { [literal]: licence });
      rejects(pack, 'secret literal');
      try {
        validateRolesPack(pack);
        expect.fail('Key material was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(RolesPackError);
        expect((error as Error).message).toContain('identity.licence["<secret>"]');
        expect((error as Error).message).not.toContain(literal);
      }
    }
    expect(() => validateRolesPack(changed(['identity', literal], 'text')))
      .toThrow('identity["<secret>"] is an unknown field');
  });
});

describe('roles pack triggers', () => {
  it('accepts voice and includes every server event type', () => {
    expectTypeOf<ServerEvent['type']>().toEqualTypeOf<(typeof ROLES_PACK_EVENTS)[number]>();
    expect(validateRolesPack(changed(['triggers', 'events'], ['voice'])).triggers.events).toEqual(['voice']);
  });

  it.each(['* * * * *', '*/15 0-23/2 1,15 1-12 0,7', '59 23 31 12 7', '0 9 * JAN,MAR MON-FRI', ' 0\t9 * * mon '])
    ('accepts cron %s', cron => {
      expect(validateRolesPack(changed(['triggers', 'schedules', 0], cron)).triggers.schedules[0]).toBe(cron);
    });

  it.each([
    '0 0 * *', '0 0 0 * * *', '60 0 * * *', '-1 0 * * *', '0 24 * * *', '0 0 0 * *', '0 0 32 * *',
    '0 0 * 0 *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '*/61 * * * *', '*/x * * * *',
    '5-1 * * * *', '1,,2 * * * *', '1/2/3 * * * *', '*-3 * * * *', '0 0 * XYZ *',
    '0 0 * * MON-SUNDAY', '0 0 * * ? ', '@daily', '1.5 * * * *', '0 0 L * *',
  ])('rejects invalid cron %s', cron => {
    expect(() => validateRolesPack(changed(['triggers', 'schedules', 0], cron))).toThrow('valid five-field cron expression');
  });

  it.each([...ROLES_PACK_EVENTS, 'custom:garden.updated', 'custom:demo-1', 'custom:demo_name'])('accepts event %s', event => {
    expect(validateRolesPack(changed(['triggers', 'events', 0], event)).triggers.events[0]).toBe(event);
  });

  it.each(['custom:', 'custom:has spaces', 'custom:Uppercase', 'custom:../outside', 'custom:name:extra', 'unlisted'])('rejects event %s', event => {
    expect(() => validateRolesPack(changed(['triggers', 'events', 0], event))).toThrow('known event or custom:<name>');
  });
});

describe('roles pack caps', () => {
  it.each(strings(example).filter(({ path }) => stringLimit(path) !== null))('caps the string field $path', ({ path }) => {
    const max = stringLimit(path)!;
    const value = 'x '.repeat(Math.ceil((max + 1) / 2)).slice(0, max + 1);
    expect(() => validateRolesPack(changed(path, value))).toThrow(`must be at most ${max} characters`);
  });

  it.each(collections(example))('caps the collection $path', ({ path, value }) => {
    const atLimit = Array.from({ length: ROLES_PACK_LIMITS.items }, () => value[0]);
    expect(() => validateRolesPack(changed(path, atLimit))).not.toThrow();
    expect(() => validateRolesPack(changed(path, [...atLimit, value[0]]))).toThrow(`must contain at most ${ROLES_PACK_LIMITS.items} items`);
  });

  it('accepts the markdown length boundary and rejects the next character', () => {
    const body = 'x '.repeat(ROLES_PACK_LIMITS.markdown / 2);
    expect(validateRolesPack(changed(['instructions', 'persona'], body)).instructions.persona).toBe(body);
    expect(() => validateRolesPack(changed(['instructions', 'persona'], body + 'x'))).toThrow('at most 32768 characters');
  });

  it('caps licence maps, secret maps and map keys', () => {
    const licence = Object.fromEntries(Array.from({ length: ROLES_PACK_LIMITS.files }, (_, i) => [`file-${i}.md`, 'MIT']));
    expect(() => validateRolesPack(changed(['identity', 'licence'], licence))).not.toThrow();
    expect(() => validateRolesPack(changed(['identity', 'licence'], { ...licence, 'overflow.md': 'MIT' }))).toThrow('at most 256 entries');
    const secrets = Object.fromEntries(Array.from({ length: ROLES_PACK_LIMITS.items }, (_, i) => [`KEY_${i}`, '${NAME}']));
    expect(() => validateRolesPack(changed(['connectors', 'secrets'], secrets))).not.toThrow();
    expect(() => validateRolesPack(changed(['connectors', 'secrets'], { ...secrets, OVERFLOW: '${NAME}' }))).toThrow('at most 100 entries');
    expect(() => validateRolesPack(changed(['identity', 'licence'], { ['x/'.repeat(513) + 'file']: 'MIT' }))).toThrow('at most 1024 characters');
    expect(() => validateRolesPack(changed(['connectors', 'secrets'], { ['KEY_'.repeat(17)]: '${NAME}' }))).toThrow('at most 64 characters');
  });

  it.each(['env', 'headers'])('caps connector %s maps, keys and references', field => {
    const path: Path = ['connectors', 'mcpServers', 0, field];
    const entries = Object.fromEntries(Array.from({ length: ROLES_PACK_LIMITS.items }, (_, i) => [`VALUE_${i}`, '${NAME}']));
    expect(() => validateRolesPack(changed(path, entries))).not.toThrow();
    expect(() => validateRolesPack(changed(path, { ...entries, OVERFLOW: '${NAME}' }))).toThrow('at most 100 entries');
    const max = field === 'env' ? 64 : ROLES_PACK_LIMITS.identifier;
    expect(() => validateRolesPack(changed(path, { ['A'.repeat(max + 1)]: '${NAME}' }))).toThrow(`at most ${max} characters`);
    expect(() => validateRolesPack(changed(path, { VALUE: '${' + 'A'.repeat(65) + '}' }))).toThrow('at most 67 characters');
  });

  it('counts input licence entries before any key can be dropped', () => {
    const licence = Object.fromEntries(Array.from({ length: ROLES_PACK_LIMITS.files }, (_, i) => [`file-${i}.md`, 'MIT']));
    Object.defineProperty(licence, '__proto__', { value: 'MIT', enumerable: true });
    expect(Object.keys(licence)).toHaveLength(ROLES_PACK_LIMITS.files + 1);
    const pack = changed(['identity', 'licence'], licence);
    expect(() => validateRolesPack(pack)).toThrow('identity.licence must contain at most 256 entries');
    expect(() => parseRolesPack(JSON.stringify(pack))).toThrow('at most 256 entries');
  });

  it('caps JSON text before parsing and accepts the exact boundary', () => {
    const padded = exampleText.padEnd(ROLES_PACK_LIMITS.document);
    expect(parseRolesPack(padded)).toEqual(example);
    expect(() => parseRolesPack(padded + ' ')).toThrow('at most 1048576 characters');
  });
});
