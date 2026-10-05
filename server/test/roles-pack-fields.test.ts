import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FILE_TOOLS, FILE_TOOL_PREFIXES, ROLES_PACK_LIMITS, ROLE_CLASSES, RolesPackError, TrimRecordSchema, WEB_TOOLS, WEB_TOOL_PREFIXES,
  classToolConflict, parseRolesPack, toolAccess, validateRolesPack, type RoleClass, type RolesPack,
} from '../../shared/roles-pack.js';

// The role fields that say what a role promises, how it is updated, whether other roles may
// call it, and what it may touch, and the load a build measures back into the pack.

const example = JSON.parse(readFileSync(new URL('../../docs/roles-pack.example.json', import.meta.url), 'utf8')) as RolesPack;
type Path = Array<string | number>;

function changed(path: Path, value: unknown): unknown {
  const copy: unknown = structuredClone(example);
  let parent = copy as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
  return copy;
}

function packWith(roleClass: RoleClass, names: string[]): RolesPack {
  const pack = structuredClone(example);
  pack.class = roleClass;
  pack.permissions.tools = names.map(name => ({ name, risk: 'standard' as const }));
  return pack;
}

function issuesFor(pack: unknown): string {
  try {
    validateRolesPack(pack);
  } catch (error) {
    expect(error).toBeInstanceOf(RolesPackError);
    return (error as RolesPackError).issues.join('\n');
  }
  throw new Error('the pack was accepted');
}

describe('role contract, updates, callable and class', () => {
  it('carries the four fields in the example and round trips them', () => {
    expect(example.contract).toBeTruthy();
    expect(example.updates).toBe('stable');
    expect(example.callable).toBe(true);
    expect(ROLE_CLASSES).toContain(example.class);
    const pack = parseRolesPack(JSON.stringify(example));
    expect(parseRolesPack(JSON.stringify(pack))).toEqual(pack);
  });

  it('accepts the contract, the channels, callability and every class', () => {
    expect(validateRolesPack(changed(['contract'], 'Ask when a request could mean two things. Say no when it cannot be done.')).contract)
      .toBe('Ask when a request could mean two things. Say no when it cannot be done.');
    for (const updates of ['stable', 'preview', { pin: '1.0.0' }, { pin: '0.1.2-rc.3' }]) {
      expect(validateRolesPack(changed(['updates'], updates)).updates).toEqual(updates);
    }
    for (const callable of [true, false]) expect(validateRolesPack(changed(['callable'], callable)).callable).toBe(callable);
    for (const roleClass of ROLE_CLASSES) expect(validateRolesPack(changed(['class'], roleClass)).class).toBe(roleClass);
  });

  it('requires each of the four fields', () => {
    for (const field of ['contract', 'updates', 'callable', 'class'] as const) {
      const pack = { ...example } as Record<string, unknown>;
      delete pack[field];
      expect(() => validateRolesPack(pack)).toThrow(field);
    }
  });

  it.each([[''], ['   '], [null], [42], ['sk-' + 'A'.repeat(20)], ['x '.repeat(16_384).trimEnd() + ' x']])
    ('rejects the contract %j', value => {
      expect(() => validateRolesPack(changed(['contract'], value))).toThrow(RolesPackError);
    });

  it('keeps the contract within the prose limit', () => {
    expect(validateRolesPack(changed(['contract'], 'x '.repeat(ROLES_PACK_LIMITS.markdown / 2))).contract.length)
      .toBe(ROLES_PACK_LIMITS.markdown);
    expect(() => validateRolesPack(changed(['contract'], 'x '.repeat(ROLES_PACK_LIMITS.markdown / 2) + 'x')))
      .toThrow('at most 32768 characters');
  });

  it.each([
    ['beta'], ['stable '], ['Stable'], [1], [{ pin: '1.0' }], [{ pin: 'latest' }], [{ pin: 1 }], [{}],
    [{ pin: '1.0.0', channel: 'stable' }], [{ channel: 'stable' }], [[]], [''],
  ] as Array<[unknown]>)('rejects the update channel %j', value => {
    const check = () => validateRolesPack(changed(['updates'], value));
    if (typeof value === 'string' && !['stable', 'preview'].includes(value)) expect(check).toThrow('"stable", "preview" or { pin: "<version>" }');
    else expect(check).toThrow(RolesPackError);
  });

  it.each([['yes'], [1], [null], [undefined], [{}]])('rejects callable %j', value => {
    expect(() => validateRolesPack(changed(['callable'], value))).toThrow(RolesPackError);
  });

  it.each(['Web', 'webby', 'public', 'local', ''])('rejects the class %s', value => {
    expect(issuesFor(changed(['class'], value))).toContain('class');
  });

  it('rejects an unknown field beside the new ones', () => {
    expect(() => validateRolesPack({ ...example, behaviour: {} })).toThrow('behaviour is an unknown field');
  });
});

describe('role class against declared tools', () => {
  const webTools = ['web_search', 'web_extract', 'web_fetch', 'web_open', 'http_get', 'http_post', 'browser_navigate', 'browser_click'];
  const fileTools = ['read_file', 'write_file', 'edit_file', 'delete_file', 'memory', 'memory_search', 'memory_delete', 'skill_load', 'skill_list', 'file_read', 'fs_read'];
  const otherTools = ['plan.write', 'weather.read', 'calendar_list', 'calendar', 'filesystem_write'];

  it.each(webTools)('knows %s as a web tool', name => {
    expect(toolAccess(name)).toBe('web');
  });

  it.each(fileTools)('knows %s as a file or memory tool', name => {
    expect(toolAccess(name)).toBe('file');
  });

  it.each(otherTools)('takes %s as neither', name => {
    expect(toolAccess(name)).toBeNull();
  });

  it('matches the names and prefixes it publishes', () => {
    expect(WEB_TOOLS.length).toBeGreaterThan(0);
    expect(FILE_TOOLS.length).toBeGreaterThan(0);
    expect(WEB_TOOL_PREFIXES.length).toBeGreaterThan(0);
    expect(FILE_TOOL_PREFIXES.length).toBeGreaterThan(0);
    for (const name of WEB_TOOLS) expect(toolAccess(name)).toBe('web');
    for (const name of FILE_TOOLS) expect(toolAccess(name)).toBe('file');
  });

  it.each([
    ['file', 'web_search'], ['private', 'web_search'], ['file', 'browser_navigate'], ['private', 'http_post'],
    ['web', 'read_file'], ['web', 'write_file'], ['web', 'memory'], ['web', 'memory_delete'], ['web', 'skill_load'], ['web', 'fs_read'],
  ] as Array<[RoleClass, string]>)('refuses %s in a "%s" role', (roleClass, name) => {
    const issues = issuesFor(packWith(roleClass, [name]));
    expect(issues).toContain('permissions.tools[0].name');
    expect(issues).not.toContain(`"${name}"`);
  });

  it.each([
    ['web', 'web_search'], ['web', 'browser_navigate'], ['file', 'read_file'], ['file', 'memory'],
    ['private', 'read_file'], ['private', 'memory_search'], ['web', 'plan.write'], ['file', 'plan.write'],
    ['private', 'plan.write'], ['file', 'web.read'],
  ] as Array<[RoleClass, string]>)('allows %s in a "%s" role', (roleClass, name) => {
    expect(validateRolesPack(packWith(roleClass, [name])).class).toBe(roleClass);
  });

  it('reports every tool that does not fit the class', () => {
    const issues = issuesFor(packWith('file', ['web_search', 'plan.write', 'read_file']));
    expect(issues).toContain('permissions.tools[0].name is a web tool');
    expect(issues).toContain('which class does not allow');
    expect(issues).not.toContain('web_search');
    expect(issues).not.toContain('plan.write');
    expect(issues).not.toContain('read_file');
  });

  it('explains the class restriction without echoing field values', () => {
    expect(issuesFor(packWith('private', ['browser_click']))).toContain('is a web tool, which class does not allow');
    expect(issuesFor(packWith('web', ['memory']))).toContain('is a file or memory tool, which class does not allow');
  });

  it.each([
    ['file', 'web_search', 'web tool'], ['private', 'browser_click', 'web tool'], ['web', 'memory', 'file or memory tool'],
    ['web', 'plan.write', null], ['file', 'read_file', null], ['private', 'plan.write', null],
  ] as Array<[RoleClass, string, string | null]>)('describes the conflict of %s and %s', (roleClass, name, detail) => {
    const conflict = classToolConflict(roleClass, name);
    if (detail === null) expect(conflict).toBeNull();
    else expect(conflict).toContain(detail);
  });

  it('applies the class rules through parseRolesPack too', () => {
    expect(() => parseRolesPack(JSON.stringify(packWith('private', ['web_search'])))).toThrow('is a web tool');
  });

  it('redacts credential-shaped text in a conflicting tool name', () => {
    const literal = 'ghs_' + 'A'.repeat(36);
    const issues = issuesFor(packWith('file', [`browser_${literal}`]));
    expect(issues).toContain('permissions.tools[0].name is a web tool');
    expect(issues).not.toContain(literal);
  });
});

describe('measured load', () => {
  it('accepts the measurement a build writes, per harness', () => {
    const measuredLoad = {
      hermes: { words: 53, tokens: 72 }, paseo: { words: 47, tokens: 63 },
      claude: { words: 47, tokens: 63 }, codex: { words: 47, tokens: 63 },
    };
    const pack = validateRolesPack(changed(['measuredLoad'], measuredLoad));
    expect(pack.measuredLoad).toEqual(measuredLoad);
    expect(parseRolesPack(JSON.stringify(pack)).measuredLoad).toEqual(measuredLoad);
  });

  it('is optional', () => {
    const pack = { ...example } as Record<string, unknown>;
    delete pack.measuredLoad;
    expect(validateRolesPack(pack).measuredLoad).toBeUndefined();
  });

  it('accepts a measurement for some harnesses only', () => {
    expect(validateRolesPack(changed(['measuredLoad'], { hermes: { words: 53, tokens: 72 } })).measuredLoad)
      .toEqual({ hermes: { words: 53, tokens: 72 } });
  });

  it.each([
    { hermes: { words: 1.5, tokens: 2 } }, { hermes: { words: -1, tokens: 2 } }, { hermes: { words: 1, tokens: '2' } },
    { hermes: { words: 1 } }, { hermes: { words: 'x', tokens: 2 } }, { hermes: { words: 1, tokens: 2, bytes: 3 } },
    { wukong: { words: 1, tokens: 2 } }, { hermes: { words: Infinity, tokens: 2 } }, [], 'measured',
    { hermes: { words: 10_000_001, tokens: 2 } }, { hermes: { words: 1, tokens: 20_000_001 } },
  ])('rejects the malformed measurement %j', value => {
    expect(() => validateRolesPack(changed(['measuredLoad'], value))).toThrow(RolesPackError);
  });
});

describe('trim records', () => {
  const record = {
    subject: 'role:garden-guide/hermes', suite: 'roletest-garden', models: ['example-model-a'],
    scoreBefore: 0.9, scoreAfter: 0.89, margin: 0.02,
    askingFailuresChecked: true, decliningFailuresChecked: true, parseFailuresChecked: true,
    ruleMapSha256: 'a'.repeat(64),
  };

  it('accepts a complete record', () => {
    expect(TrimRecordSchema.parse(record)).toEqual(record);
  });

  it('takes the record out of JSON unchanged', () => {
    expect(TrimRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it.each([
    'repository-specific-agent-instruction-maintenance', 'garden-'.repeat(18) + 'id',
    'repositoryspecificagentinstructionmaintenance', 'a1'.repeat(64), 'abcdef01'.repeat(8),
  ])
    ('accepts descriptive identifiers in trim subjects: %s', id => {
      for (const subject of [`role:${id}/hermes`, `skill:${id}`, `skill:${id}/skills/${id}/SKILL.md`, `budget:${id}`]) {
        expect(TrimRecordSchema.parse({ ...record, subject }).subject).toBe(subject);
      }
    });

  it('accepts long identifiers and encoded text in trim evidence', () => {
    const trimmed = {
      ...record, subject: 'repositorySpecificAgentInstructionMaintenance',
      suite: 'ZmFr'.repeat(16), models: ['repositorySpecificAgentInstructionMaintenance', 'abcdef01'.repeat(8)],
    };
    expect(TrimRecordSchema.parse(trimmed)).toEqual(trimmed);
  });

  it('accepts composite subjects with long role ids and the longest valid bundled path', () => {
    const roleId = 'garden-'.repeat(5) + 'grow';
    const path = 'skills/' + 'garden.x/'.repeat(112) + 'xSKILL.md';
    expect(roleId.length).toBeLessThanOrEqual(ROLES_PACK_LIMITS.identifier);
    expect(path).toHaveLength(ROLES_PACK_LIMITS.path);
    const pack = structuredClone(example);
    pack.identity.id = roleId;
    pack.skills.private = [{ path, sha256: 'a'.repeat(64) }];
    expect(validateRolesPack(pack).skills.private[0]!.path).toBe(path);
    for (const subject of [`role:${roleId}/hermes`, `skill:${roleId}`, `skill:${roleId}/${path}`, `budget:${roleId}`]) {
      expect(TrimRecordSchema.parse({ ...record, subject }).subject).toBe(subject);
    }
    expect(TrimRecordSchema.safeParse({ ...record, subject: `skill:${roleId}/${path}x` }).success).toBe(false);
  });

  it.each([
    'skill:garden-guide/../SKILL.md', 'skill:garden-guide//SKILL.md', 'role:garden-guide/unknown',
    'budget:../garden-guide', 'skill:garden-guide/notes/ghp_' + 'A'.repeat(36),
  ])('keeps component validation for subject %s', subject => {
    expect(TrimRecordSchema.safeParse({ ...record, subject }).success).toBe(false);
  });

  it.each([
    { ...record, subject: '' }, { ...record, suite: '' }, { ...record, models: [] }, { ...record, models: [''] },
    { ...record, models: 'example-model-a' }, { ...record, scoreBefore: -1 }, { ...record, scoreAfter: 'x' },
    { ...record, margin: -0.01 }, { ...record, askingFailuresChecked: 'yes' },
    { ...record, decliningFailuresChecked: undefined }, { ...record, ruleMapSha256: 'z'.repeat(64) },
    { ...record, ruleMapSha256: 'a'.repeat(63) }, { ...record, checkedBy: 'nobody' }, { subject: record.subject },
  ])('rejects the incomplete record %j', value => {
    expect(TrimRecordSchema.safeParse(value).success).toBe(false);
  });
});
