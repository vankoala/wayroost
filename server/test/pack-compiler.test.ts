import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PACK_BUDGETS, PackCompileError, compilePacks, countWords, estimateTokens, measureSkillCore, skillCoreText,
  skillFrontMatter, skillVersion, type CompileInput, type DefaultLoad, type PackBuild, type ScanFile,
} from '../src/team/pack-compiler.js';
import { ROLES_PACK_LIMITS, parseRolesPack, type TrimRecord } from '../../shared/roles-pack.js';
import { productionSettingsReaders } from '../src/settings/readers.js';
import { parseConfig } from '../src/config.js';

// Built at run time so the source holds no key-shaped literal.
const SK_PROJ = 'sk' + '-proj-';

// The roles-pack compiler: it builds one prompt file per role per harness out of the source
// folder, measures what each role costs, keeps the pins, and refuses what it cannot vouch for.
// Everything below is written to a temporary folder at run time.

const HARNESSES = ['hermes', 'paseo', 'claude', 'codex'];
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** n distinct words, so a miscount names itself in a failure. */
function words(n: number, tag = 'word'): string {
  return Array.from({ length: n }, (_, index) => `${tag}${index}`).join(' ');
}

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function skillFile(core: string, extra = ''): string {
  return `---\nname: seasonal-planning\ndescription: Plan the garden by season.\nversion: 1.0.0\n---${extra}\n\n${core}\n`;
}

/** The default tree measures 53 words on hermes and 47 on every other harness. */
const SKILL = skillFile(words(5, 'core'));
const HERMES_WORDS = 10 + 20 + 4 + 8 + 6 + 5;
const OTHER_WORDS = HERMES_WORDS - 6;
const ROLE_HERMES_WORDS = 4 + 8 + 6;
const ROLE_OTHER_WORDS = ROLE_HERMES_WORDS - 6;
const BUNDLED = '---\nname: potato\ndescription: Grows underground.\nversion: 0.2.0\n---\n\n' + `${words(7, 'hill')}\n`;
const credentialVersions = [
  'sk-' + 'a'.repeat(20), SK_PROJ + 'a'.repeat(20),
  'sk_live_fake', 'sk_test_fake', 'rk_live_fake', 'rk_test_fake',
  // Key-shaped values are built at run time so the repository itself holds no key-shaped literal.
  ...['p', 'o', 'u', 's', 'r'].map(kind => `gh${kind}_fake`), ['github', 'pat', 'fake'].join('_'),
  ...['b', 'a', 'p', 'r', 's'].map(kind => `xox${kind}-fake`),
  'AKIA' + '0'.repeat(16), 'ASIA' + '0'.repeat(16), 'AIza_fake', 'glpat-fake', 'hf_fake',
].flatMap(value => [`1.0.0-${value}`, `1.0.0+${value}`]);

interface TreeOptions {
  rules?: Partial<Record<string, string>>;
  dispatch?: Partial<Record<string, string>>;
  skill?: string;
  skillPin?: Partial<{ id: string; version: string; sha256: string }>;
  extra?: Record<string, string>;
  role?: (pack: Record<string, unknown>) => void;
  budgets?: unknown;
}

function rolePack(skill: string, options: TreeOptions = {}): Record<string, unknown> {
  const pack: Record<string, unknown> = {
    identity: { id: 'garden-guide', name: 'Garden Guide', version: '1.0.0', author: 'Example Authors', licence: { 'instructions/persona.md': 'MIT' } },
    contract: words(8, 'contract'),
    updates: 'stable',
    callable: true,
    class: 'file',
    instructions: { persona: words(4, 'persona'), overlays: { hermes: words(6, 'overlay') } },
    skills: { shared: [{ id: 'seasonal-planning', version: '1.0.0', sha256: hash(skill) }], private: [] },
    connectors: { mcpServers: [] },
    permissions: { tools: [{ name: 'plan.write', risk: 'standard' }], sandbox: 'workspace', limits: { timeMinutes: 30, costUsd: 2 }, readOnly: false },
    triggers: { schedules: [], events: [] },
    memory: { facts: [] },
    model: { declared: { provider: 'example-provider', model: 'demo-model' }, testedWith: [], evalRuns: [] },
    evals: { tasks: [], results: [] },
    onboarding: { interviewQuestions: [], conversationStarters: [], disclaimer: 'Garden advice depends on local conditions.' },
    providerIds: { hermes: 'demo-garden' },
  };
  if (options.skillPin) {
    pack.skills = { shared: [{ ...(pack.skills as { shared: [Record<string, unknown>] }).shared[0]!, ...options.skillPin }], private: [] };
  }
  options.role?.(pack);
  return pack;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function tree(options: TreeOptions = {}): string {
  const root = new URL('../../.tmp/', import.meta.url);
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(fileURLToPath(root), 'wayroost-pack-'));
  tempDirs.push(dir);
  const skill = options.skill ?? SKILL;
  const files: Record<string, string> = {
    'skills/seasonal-planning/SKILL.md': skill,
    'roles/garden-guide/role.json': JSON.stringify(rolePack(skill, options)),
  };
  for (const harness of HARNESSES) {
    files[`shared/rules/${harness}.md`] = options.rules?.[harness] ?? words(10, 'rules');
    files[`shared/dispatch/${harness}.md`] = options.dispatch?.[harness] ?? words(20, 'dispatch');
  }
  Object.assign(files, options.extra ?? {});
  if (options.budgets !== undefined) files['budgets.json'] = typeof options.budgets === 'string'
    ? options.budgets : JSON.stringify(options.budgets);
  writeFiles(dir, files);
  return dir;
}

const accept: ScanFile = () => ({ ok: true, reasons: [] });

function compile(dir: string, over: Partial<CompileInput> = {}): PackBuild {
  return compilePacks({ sourceDir: dir, packVersion: '1.0.0', scan: accept, ...over });
}

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PackCompileError);
    return (error as PackCompileError).issues.join('\n');
  }
  throw new Error('the build succeeded');
}

const defaultLoad = (over: Partial<DefaultLoad> = {}): DefaultLoad => ({ roles: [], skills: [], budgets: [], ...over });

function defaultFrom(build: PackBuild): DefaultLoad {
  return {
    roles: build.loads.map(load => {
      const pack = build.roles[load.roleId]!;
      return {
        roleId: load.roleId, harness: load.harness, words: load.roleWords,
        skillIds: [
          ...pack.skills.shared.map(skill => skill.id),
          ...pack.skills.private.map(skill => `${load.roleId}/${skill.path}`),
        ],
      };
    }),
    skills: build.skills.map(skill => ({
      skillId: skill.id,
      words: build.loads.flatMap(load => load.parts).find(part => part.name === `skill ${skill.id}`
        || part.name === `skill ${skill.id.slice(skill.id.indexOf('/') + 1)}`)!.words,
    })),
    budgets: build.loads.filter(load => load.budgetWords !== null)
      .map(load => ({ roleId: load.roleId, words: load.budgetWords! })),
  };
}

function trimRecord(subject: string, over: Partial<TrimRecord> = {}): TrimRecord {
  return {
    subject, suite: 'roletest-garden', models: ['example-model-a', 'example-model-b'],
    scoreBefore: 0.9, scoreAfter: 0.88, margin: 0.02,
    askingFailuresChecked: true, decliningFailuresChecked: true, parseFailuresChecked: true,
    ruleMapSha256: 'a'.repeat(64), ...over,
  };
}

function loadOf(build: PackBuild, harness: string) {
  return build.loads.find(load => load.harness === harness)!;
}

describe('descriptive source identifiers', () => {
  it.each([
    ['repository-specific-agent-instruction-maintenance', false],
    ['repository-specific-agent-instruction-maintenance', true],
    ['garden-'.repeat(18) + 'id', false],
    ['garden-'.repeat(18) + 'id', true],
    ['repositoryspecificagentinstructionmaintenance', false],
    ['repositoryspecificagentinstructionmaintenance', true],
    ['a1'.repeat(64), false],
    ['a1'.repeat(64), true],
    ['abcdef01'.repeat(8), false],
    ['abcdef01'.repeat(8), true],
  ] as const)('compiles role and skill id %s with explicit selection %s', (id, selected) => {
    const options: TreeOptions = {
      skillPin: { id },
      role: pack => { (pack.identity as Record<string, unknown>).id = id; },
      extra: { [`skills/${id}/SKILL.md`]: SKILL },
    };
    const dir = tree(options);
    writeFiles(dir, { [`roles/${id}/role.json`]: JSON.stringify(rolePack(SKILL, options)) });
    rmSync(join(dir, 'roles/garden-guide'), { recursive: true });
    const build = compile(dir, { harnesses: ['hermes'], ...(selected ? { roles: [id] } : {}) });
    expect(build.roles[id]!.identity.id).toBe(id);
    expect(build.roles[id]!.skills.shared[0]!.id).toBe(id);
    expect(build.roles[id]!.measuredLoad!.hermes).toEqual({ words: HERMES_WORDS, tokens: estimateTokens(HERMES_WORDS) });
    expect(build.receipt.skills).toEqual([{ id, version: '1.0.0', sha256: hash(SKILL) }]);
    expect(build.receipt.files).toEqual([{ path: `roles/${id}/hermes.md`, sha256: hash(build.files[0]!.content) }]);
  });

  it('compiles camelCase names, bundled paths and long encoded prose', () => {
    const name = 'repositorySpecificAgentInstructionMaintenance';
    const path = `skills/${name}/SKILL.md`;
    const persona = `${name} ${'abcdef01'.repeat(8)} ${'ZmFr'.repeat(16)} ${'a1'.repeat(64)}`;
    const dir = tree({
      role: pack => {
        (pack.identity as Record<string, unknown>).name = name;
        (pack.identity as Record<string, unknown>).licence = { [`${name}.md`]: 'MIT' };
        pack.instructions = { persona };
        pack.skills = { shared: [], private: [{ path, sha256: hash(BUNDLED) }] };
      },
      extra: { [`roles/garden-guide/${path}`]: BUNDLED },
    });
    const build = compile(dir, { harnesses: ['hermes'] });
    expect(build.files[0]!.content).toContain(persona);
    expect(build.roles['garden-guide']!.identity.name).toBe(name);
    expect(build.roles['garden-guide']!.measuredLoad!.hermes)
      .toEqual({ words: 10 + 20 + 4 + 8 + 7, tokens: estimateTokens(10 + 20 + 4 + 8 + 7) });
    expect(build.receipt.skills).toEqual([{ id: `garden-guide/${path}`, version: '0.2.0', sha256: hash(BUNDLED) }]);
  });
});

describe('compiling pack sources', () => {
  it('builds one prompt file per role per harness', () => {
    const build = compile(tree());
    expect(build.files.map(file => file.path)).toEqual(HARNESSES.map(harness => `roles/garden-guide/${harness}.md`));
    expect(Object.keys(build.roles)).toEqual(['garden-guide']);
    expect(build.loads).toHaveLength(4);
  });

  it('puts the shared rules, the dispatch protocol, the role and its skills in that order', () => {
    const dir = tree();
    const file = compile(dir).files.find(entry => entry.harness === 'hermes')!;
    const markers = ['rules0', 'dispatch0', 'persona0', 'contract0', 'overlay0', 'core0'];
    const positions = markers.map(marker => file.content.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(file.content).not.toContain('description: Plan the garden by season.');
    expect(readFileSync(join(dir, 'skills/seasonal-planning/SKILL.md'), 'utf8')).toContain('core0');
  });

  it('builds the harnesses it is asked for and defaults to all of them', () => {
    const dir = tree();
    expect(compile(dir, { harnesses: ['paseo'] }).files.map(file => file.harness)).toEqual(['paseo']);
    expect(compile(dir).files.map(file => file.harness)).toEqual(HARNESSES);
  });

  it('measures each role per harness in words and estimated tokens', () => {
    const build = compile(tree());
    const hermes = loadOf(build, 'hermes');
    expect(hermes).toMatchObject({ roleId: 'garden-guide', harness: 'hermes', words: HERMES_WORDS, tokens: estimateTokens(HERMES_WORDS) });
    expect(hermes.tokens).toBe(72);
    for (const harness of HARNESSES.filter(name => name !== 'hermes')) {
      expect(loadOf(build, harness)).toMatchObject({ words: OTHER_WORDS, tokens: estimateTokens(OTHER_WORDS) });
    }
    expect(estimateTokens(100)).toBe(135);
    expect(estimateTokens(1)).toBe(1);
  });

  it('shows the measurement section by section', () => {
    const hermes = loadOf(compile(tree()), 'hermes');
    expect(hermes.parts).toEqual([
      { name: 'shared rules', words: 10 },
      { name: 'dispatch protocol', words: 20 },
      { name: 'role section', words: 4 + 8 + 6 },
      { name: 'skill seasonal-planning', words: 5 },
    ]);
    expect(hermes.parts.reduce((total, part) => total + part.words, 0)).toBe(hermes.words);
    expect(hermes.words).toBe(countWords(compile(tree()).files[0]!.content));
  });

  it('writes the measurement into the pack', () => {
    const build = compile(tree());
    expect(build.roles['garden-guide']!.measuredLoad).toEqual({
      hermes: { words: HERMES_WORDS, tokens: 72 },
      paseo: { words: OTHER_WORDS, tokens: 63 },
      claude: { words: OTHER_WORDS, tokens: 63 },
      codex: { words: OTHER_WORDS, tokens: 63 },
    });
    expect(build.roles['garden-guide']!.contract).toBe(words(8, 'contract'));
  });

  it('warns above the target without failing the build', () => {
    const build = compile(tree(), { harnesses: ['hermes', 'paseo'], targetWords: OTHER_WORDS + 1 });
    expect(build.warnings).toEqual([`role "garden-guide" on hermes measures ${HERMES_WORDS} words, above the 48-word target`]);
    expect(compile(tree(), { targetWords: HERMES_WORDS }).warnings).toEqual([]);
  });

  it('takes the 4,000-word target as the default', () => {
    expect(PACK_BUDGETS.roleTargetWords).toBe(4_000);
    expect(compile(tree()).warnings).toEqual([]);
    expect(compile(tree(), { targetWords: 4_000 }).warnings).toEqual([]);
    const build = compile(tree({ rules: { hermes: words(4_000, 'rules') } }), { harnesses: ['hermes'] });
    expect(build.warnings).toEqual([`role "garden-guide" on hermes measures ${4_000 + HERMES_WORDS - 10} words, above the 4000-word target`]);
  });

  it('fails a role over its recorded budget', () => {
    expect(failureOf(() => compile(tree({ budgets: { 'garden-guide': { words: OTHER_WORDS } } }))))
      .toContain('roles/ folder 0 measuredLoad.hermes.words exceeds the recorded budgets.words');
    expect(compile(tree({ budgets: { 'garden-guide': { words: HERMES_WORDS } } })).warnings).toEqual([]);
  });

  it('takes the recorded budget as the hard limit and the target as the warning line', () => {
    const build = compile(tree({ budgets: { 'garden-guide': { words: 20_000 } } }));
    expect(build.loads[0]).toMatchObject({ budgetWords: 20_000, targetWords: PACK_BUDGETS.roleTargetWords });
    expect(compile(tree({ budgets: { 'garden-guide': { words: HERMES_WORDS } } }), { targetWords: 10 }).warnings)
      .toHaveLength(4);
  });

  it('warns instead of failing when a role has no recorded budget', () => {
    const build = compile(tree(), { targetWords: 10 });
    expect(build.warnings).toHaveLength(4);
    expect(build.loads[0]).toMatchObject({ budgetWords: null, words: HERMES_WORDS });
  });

  it('reads budgets.json from the source folder', () => {
    expect(failureOf(() => compile(tree({ budgets: '{' })))).toContain('budgets.json is not valid JSON');
    expect(failureOf(() => compile(tree({ budgets: ['garden-guide'] })))).toContain('must map role ids to');
    expect(failureOf(() => compile(tree({ budgets: { 'garden-guide': { words: 'many' } } }))))
      .toContain('budgets.json entry 0 must give "words" as a positive number');
  });

  it('reports the sources it cannot read', () => {
    const noRules = tree();
    rmSync(join(noRules, 'shared/rules/hermes.md'));
    expect(failureOf(() => compile(noRules, { harnesses: ['hermes'] }))).toContain('the shared rules for hermes are missing');
    const noProtocol = tree();
    rmSync(join(noProtocol, 'shared/dispatch/codex.md'));
    expect(failureOf(() => compile(noProtocol, { harnesses: ['codex'] }))).toContain('the dispatch protocol for codex is missing');
    const noRoles = tree();
    rmSync(join(noRoles, 'roles'), { recursive: true });
    expect(failureOf(() => compile(noRoles))).toContain('roles is missing or cannot be read');
  });

  it('reports a role folder that is not there', () => {
    expect(failureOf(() => compile(tree(), { roles: ['tomato-guide'] }))).toContain('roles[0] has no folder under roles/');
    expect(compile(tree(), { roles: ['garden-guide'], harnesses: ['hermes'] }).files).toHaveLength(1);
  });

  it('refuses a role folder whose name the compiler cannot read', () => {
    const dir = tree();
    expect(failureOf(() => compile(dir, { roles: ['../outside'] }))).toContain('roles[0] is not a folder name the compiler can read');
  });

  it('refuses a role folder that is not named with a slug', () => {
    const dir = tree({ extra: { 'roles/Draft Notes/role.json': JSON.stringify(rolePack(SKILL)) } });
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain('roles/ folder 0 is not named with a lowercase slug');
  });

  it('refuses a role folder that holds a pack for another role', () => {
    const dir = tree({ extra: { 'roles/tomato-guide/role.json': JSON.stringify(rolePack(SKILL)) } });
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain('roles/ folder 1 folder does not match the pack identity.id');
  });

  it('reports a role.json that is missing, malformed or invalid', () => {
    const missing = tree();
    rmSync(join(missing, 'roles/garden-guide/role.json'));
    expect(failureOf(() => compile(missing, { harnesses: ['hermes'] }))).toContain('roles/ folder 0 has no role.json');
    const malformed = tree();
    writeFiles(malformed, { 'roles/garden-guide/role.json': '{' });
    expect(failureOf(() => compile(malformed, { harnesses: ['hermes'] }))).toContain('roles/ folder 0 role.json is not valid JSON');
    const invalid = tree({ role: pack => { pack.class = 'public'; } });
    expect(failureOf(() => compile(invalid, { harnesses: ['hermes'] }))).toContain('roles/ folder 0 role.json: class');
  });

  it('enforces the public parser\'s role-document size limit', () => {
    const dir = tree();
    const file = join(dir, 'roles/garden-guide/role.json');
    const atLimit = readFileSync(file, 'utf8').padEnd(ROLES_PACK_LIMITS.document, ' ');
    writeFileSync(file, atLimit);
    expect(compile(dir, { harnesses: ['hermes'] }).roles['garden-guide']!.identity.id).toBe('garden-guide');
    const overLimit = atLimit + ' ';
    expect(() => parseRolesPack(overLimit)).toThrow('must be at most');
    writeFileSync(file, overLimit);
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain(`must be at most ${ROLES_PACK_LIMITS.document} characters`);
  });

  it('builds every role folder, and only those asked for', () => {
    const second = rolePack(SKILL);
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const dir = tree({ extra: { 'roles/tomato-guide/role.json': JSON.stringify(second) } });
    const build = compile(dir, { harnesses: ['hermes'] });
    expect(Object.keys(build.roles)).toEqual(['garden-guide', 'tomato-guide']);
    expect(build.files.map(file => file.path)).toEqual(['roles/garden-guide/hermes.md', 'roles/tomato-guide/hermes.md']);
  });

  it('refuses a pack version that is not a semantic version', () => {
    expect(failureOf(() => compilePacks({ sourceDir: tree(), packVersion: 'v1.0', scan: accept }))).toContain('pack version must be a semantic version');
    expect(compilePacks({ sourceDir: tree(), packVersion: '1.0.0-rc.1', scan: accept })).toBeTruthy();
  });

  it('refuses an empty or repeated selection and an invalid target', () => {
    const dir = tree();
    for (const selection of [{ harnesses: [] }, { harnesses: ['hermes', 'hermes'] }, { roles: [] }, { roles: ['garden-guide', 'garden-guide'] }]) {
      expect(failureOf(() => compile(dir, selection as Partial<CompileInput>))).toMatch(/requires|repeat/);
    }
    for (const targetWords of [0, -1, Infinity, NaN, 1.5]) {
      expect(failureOf(() => compile(dir, { targetWords }))).toContain('the role target must be a positive integer');
    }
    expect(failureOf(() => compile(dir, { harnesses: ['../outside'] as unknown as CompileInput['harnesses'] })))
      .toContain('is not a harness a pack compiles for');
  });

  it('refuses a source link that escapes the pack folder', () => {
    const outside = tree();
    const dir = tree();
    const file = join(dir, 'skills/seasonal-planning/SKILL.md');
    rmSync(file);
    symlinkSync(join(outside, 'skills/seasonal-planning/SKILL.md'), file);
    expect(failureOf(() => compile(dir))).toContain('has no SKILL.md');
  });

  it('reports invalid selections without echoing field values', () => {
    const marker = 'ghp_' + 'EXAMPLE'.repeat(6);
    const dir = tree();
    for (const over of [
      { packVersion: marker }, { roles: [marker] },
      { harnesses: [marker] as unknown as CompileInput['harnesses'] },
    ]) {
      expect(failureOf(() => compile(dir, over))).not.toContain(marker);
    }
    expect(failureOf(() => compile(tree({ budgets: { [marker]: { words: marker } } }))))
      .toContain('budgets.json entry 0 must give "words" as a positive number');
  });

  it.each(['missing folder', 'duplicate selection', 'missing pack', 'malformed pack', 'invalid pack', 'identity mismatch', 'external folder'])
    ('omits credential-shaped slugs from role diagnostics for %s', kind => {
      const marker = SK_PROJ + 'a'.repeat(24);
      const dir = tree();
      let roles = ['garden-guide', marker];
      if (kind === 'external folder') {
        symlinkSync(join(tree(), 'roles/garden-guide'), join(dir, 'roles', marker));
      } else if (kind !== 'missing folder') {
        mkdirSync(join(dir, 'roles', marker));
        if (kind === 'duplicate selection') roles = ['garden-guide', marker, marker];
        if (kind === 'malformed pack') writeFiles(dir, { [`roles/${marker}/role.json`]: '{' });
        if (kind === 'invalid pack') {
          const pack = rolePack(SKILL);
          (pack.identity as Record<string, unknown>).id = marker;
          writeFiles(dir, { [`roles/${marker}/role.json`]: JSON.stringify(pack) });
        }
        if (kind === 'identity mismatch') {
          writeFiles(dir, { [`roles/${marker}/role.json`]: JSON.stringify(rolePack(SKILL)) });
        }
      }
      const scanned: string[] = [];
      const issues = failureOf(() => compile(dir, {
        roles, harnesses: ['hermes'],
        scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
      }));
      expect(issues).toContain(kind === 'duplicate selection' ? 'roles[2]' : 'roles[1]');
      expect(issues).not.toContain(marker);
      expect(issues).not.toContain(SK_PROJ);
      expect(scanned).toEqual([]);
    });

  it.each(['missing pack', 'malformed pack', 'invalid pack', 'identity mismatch'])
    ('omits credential-shaped slugs from discovered role diagnostics for %s', kind => {
      const marker = SK_PROJ + 'a'.repeat(24);
      const dir = tree();
      mkdirSync(join(dir, 'roles', marker));
      if (kind === 'malformed pack') writeFiles(dir, { [`roles/${marker}/role.json`]: '{' });
      if (kind === 'invalid pack' || kind === 'identity mismatch') {
        const pack = rolePack(SKILL);
        if (kind === 'invalid pack') (pack.identity as Record<string, unknown>).id = marker;
        writeFiles(dir, { [`roles/${marker}/role.json`]: JSON.stringify(pack) });
      }
      const issues = failureOf(() => compile(dir, { harnesses: ['hermes'] }));
      expect(issues).toContain('roles/ folder 1');
      expect(issues).not.toContain(marker);
      expect(issues).not.toContain(SK_PROJ);
    });

  it('keeps source positions when an earlier role is invalid', () => {
    const marker = SK_PROJ + 'a'.repeat(24);
    const dir = tree();
    mkdirSync(join(dir, 'roles', marker));
    const selected = failureOf(() => compile(dir, { roles: ['../outside', marker], harnesses: ['hermes'] }));
    expect(selected).toContain('roles[0] is not a folder name');
    expect(selected).toContain('roles[1] has no role.json');
    mkdirSync(join(dir, 'roles', 'Draft Notes'));
    const discovered = failureOf(() => compile(dir, { harnesses: ['hermes'] }));
    expect(discovered).toContain('roles/ folder 0 is not named with a lowercase slug');
    expect(discovered).toContain('roles/ folder 2 has no role.json');
    for (const issues of [selected, discovered]) {
      expect(issues).not.toContain(marker);
      expect(issues).not.toContain('Draft Notes');
      expect(issues).not.toContain('../outside');
    }
  });

  it('reports skill and scanner positions without echoing source identifiers', () => {
    const missingSkill = tree();
    rmSync(join(missingSkill, 'skills/seasonal-planning/SKILL.md'));
    const missing = failureOf(() => compile(missingSkill, { harnesses: ['hermes'] }));
    expect(missing).toContain('roles/ folder 0 skills.shared[0] has no SKILL.md');
    const flagged = failureOf(() => compile(tree(), { scan: () => ({ ok: false, reasons: ['refused'] }) }));
    expect(flagged).toContain('files[0]: the scanner flagged it at reasons[0]');
    for (const issues of [missing, flagged]) {
      expect(issues).not.toContain('garden-guide');
      expect(issues).not.toContain('seasonal-planning');
    }
  });

  it.each([undefined, ['garden-guide']])('refuses an external roles directory with role.json linked inside for selection %j', roles => {
    const pack = rolePack(SKILL, {
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
    });
    const outside = tree({ extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED } });
    const dir = tree({ extra: { 'role.json': JSON.stringify(pack) } });
    const outsidePack = join(outside, 'roles/garden-guide/role.json');
    rmSync(outsidePack);
    symlinkSync(join(dir, 'role.json'), outsidePack);
    rmSync(join(dir, 'roles'), { recursive: true });
    symlinkSync(join(outside, 'roles'), join(dir, 'roles'));
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'], roles })))
      .toContain(`${roles ? 'roles[0]' : 'roles/ folder 0'} folder must remain inside the source folder`);
  });

  it('refuses an external role directory even when all its files link inside', () => {
    const pack = rolePack(SKILL, {
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
    });
    const outside = tree();
    const dir = tree({ extra: { 'role.json': JSON.stringify(pack), 'SKILL.md': BUNDLED } });
    rmSync(join(outside, 'roles/garden-guide/role.json'));
    symlinkSync(join(dir, 'role.json'), join(outside, 'roles/garden-guide/role.json'));
    mkdirSync(join(outside, 'roles/garden-guide/skills/potato'), { recursive: true });
    symlinkSync(join(dir, 'SKILL.md'), join(outside, 'roles/garden-guide/skills/potato/SKILL.md'));
    rmSync(join(dir, 'roles/garden-guide'), { recursive: true });
    symlinkSync(join(outside, 'roles/garden-guide'), join(dir, 'roles/garden-guide'));
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'], roles: ['garden-guide'] })))
      .toContain('roles[0] folder must remain inside the source folder');
  });

  it('refuses a bundled source link that escapes its role folder', () => {
    const dir = tree({
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
      extra: { 'SKILL.md': BUNDLED },
    });
    mkdirSync(join(dir, 'roles/garden-guide/skills/potato'), { recursive: true });
    symlinkSync(join(dir, 'SKILL.md'), join(dir, 'roles/garden-guide/skills/potato/SKILL.md'));
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] }))).toContain('skills.private[0] is missing');
  });

  it('accepts source links that remain inside the source folder', () => {
    const dir = tree({
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
      extra: { 'roles/garden-guide/core.md': BUNDLED },
    });
    mkdirSync(join(dir, 'roles/garden-guide/skills/potato'), { recursive: true });
    symlinkSync(join(dir, 'roles/garden-guide/core.md'), join(dir, 'roles/garden-guide/skills/potato/SKILL.md'));
    symlinkSync(dir, join(dir, 'source-link'));
    const build = compile(join(dir, 'source-link'), { harnesses: ['hermes'] });
    expect(build.skills[0]!.sha256).toBe(hash(BUNDLED));
  });
});

describe('credential-free version metadata', () => {
  it.each(credentialVersions)('refuses pack version %s before scanning', packVersion => {
    const scanned: string[] = [];
    const message = failureOf(() => compile(tree(), {
      packVersion, scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
    }));
    expect(message).toContain('pack version must use a ${NAME} reference instead of a secret literal');
    expect(message).not.toContain(packVersion);
    expect(scanned).toEqual([]);
  });

  it.each(credentialVersions)('refuses bundled skill version %s before scanning', version => {
    const skill = BUNDLED.replace('version: 0.2.0', `version: ${version}`);
    const dir = tree({
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(skill) }] }; },
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': skill },
    });
    const scanned: string[] = [];
    expect(skillVersion(skill)).toBeNull();
    const message = failureOf(() => compile(dir, {
      scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
    }));
    expect(message).toContain('skills.private[0] names no semantic version in its front matter');
    expect(message).not.toContain(version);
    expect(scanned).toEqual([]);
  });

  it('refuses credential-bearing shared skill metadata before scanning', () => {
    const version = '1.0.0-sk' + '-' + 'a'.repeat(20);
    const skill = SKILL.replace('version: 1.0.0', `version: ${version}`);
    const scanned: string[] = [];
    const message = failureOf(() => compile(tree({ skill }), {
      scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
    }));
    expect(message).toContain('skills.shared[0] SKILL.md names no semantic version in its front matter');
    expect(message).not.toContain(version);
    expect(scanned).toEqual([]);
  });

  it.each([
    '1.0.0-sk' + '-' + 'a'.repeat(19), '1.0.0-' + SK_PROJ + 'a'.repeat(19),
    '1.0.0-repositorySpecificAgentInstructionMaintenance', '1.0.0-' + 'abcdef01'.repeat(8),
    '1.0.0+' + 'ZmFr'.repeat(16),
  ])('accepts ordinary long version metadata %s', version => {
    const shared = SKILL.replace('version: 1.0.0', `version: ${version}`);
    const bundled = BUNDLED.replace('version: 0.2.0', `version: ${version}`);
    const dir = tree({
      skill: shared, skillPin: { version },
      role: pack => {
        (pack.skills as { private: unknown[] }).private = [{ path: 'skills/potato/SKILL.md', sha256: hash(bundled) }];
      },
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': bundled },
    });
    const build = compile(dir, { packVersion: version });
    expect(build.receipt.packVersion).toBe(version);
    expect(build.receipt.skills.map(skill => skill.version)).toEqual([version, version]);
    expect(build.defaultEligible).toBe(true);
  });

  it('refuses credential-named licence fields during compilation', () => {
    const dir = tree({ role: pack => { (pack.identity as Record<string, unknown>).licence = { API_KEY: 'MIT' }; } });
    expect(failureOf(() => compile(dir))).toContain('identity.licence.API_KEY must be a ${NAME} secret reference');
  });
});

describe('skill budgets', () => {
  it('refuses a skill whose core rules pass the cap', () => {
    const over = skillFile(words(PACK_BUDGETS.skillCoreWords + 1, 'core'));
    expect(failureOf(() => compile(tree({ skill: over }))))
      .toContain(`roles/ folder 0 skills.shared[0] core rules are 1501 words, over the 1500-word cap`);
    expect(compile(tree({ skill: skillFile(words(PACK_BUDGETS.skillCoreWords, 'core')) }))).toBeTruthy();
  });

  it('warns above the target without refusing the skill', () => {
    const warnings = compile(tree({ skill: skillFile(words(501, 'core')) })).warnings;
    expect(warnings).toEqual(['skill "seasonal-planning" core rules are 501 words, above the 500-word target']);
    expect(compile(tree({ skill: skillFile(words(500, 'core')) })).warnings).toEqual([]);
  });

  it.each([
    [500, null, null],
    [501, 'core rules are 501 words, above the 500-word target', null],
    [1_500, 'core rules are 1500 words, above the 500-word target', null],
    [1_501, null, 'core rules are 1501 words, over the 1500-word cap'],
  ])('measures %i core words as warning %j and refusal %j', (n, warning, refused) => {
    const load = measureSkillCore(skillFile(words(n, 'core')));
    expect(load.words).toBe(n);
    expect(load.tokens).toBe(estimateTokens(n));
    expect(load.warning).toBe(warning);
    expect(load.refused).toBe(refused);
  });

  it('excludes the front matter from a skill core', () => {
    const front = skillFile(words(10, 'core'));
    expect(skillFrontMatter(front)).toContain('name: seasonal-planning');
    expect(skillCoreText(front).trim()).toBe(words(10, 'core'));
    expect(measureSkillCore(front).words).toBe(10);
    const heavy = `---\nname: seasonal-planning\ndescription: ${words(2_000, 'front')}\nversion: 1.0.0\n---\n\n${words(10, 'core')}\n`;
    expect(measureSkillCore(heavy).words).toBe(10);
    expect(measureSkillCore(heavy).warning).toBeNull();
    expect(skillCoreText('no front matter here')).toBe('no front matter here');
  });

  it('takes no account of a skill folder\'s references', () => {
    const build = compile(tree({ extra: { 'skills/seasonal-planning/references/plants.md': words(6_000, 'ref') } }));
    expect(build.warnings).toEqual([]);
    expect(build.skills).toEqual([{ id: 'seasonal-planning', version: '1.0.0', sha256: hash(SKILL) }]);
    expect(build.files[0]!.content).not.toContain('ref0');
  });

  it('refuses a bundled skill over the cap, and counts its core within it', () => {
    const bundled = '---\nname: potato\ndescription: Grows underground.\nversion: 0.2.0\n---\n\n' +
      `${words(PACK_BUDGETS.skillCoreWords + 5, 'hill')}\n`;
    const dir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': bundled },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(bundled) }] }; },
    });
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain('core rules are 1505 words, over the 1500-word cap');
  });

  it('compiles a role\'s own bundled skill and pins it by its path', () => {
    const dir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
    });
    const build = compile(dir, { harnesses: ['hermes'] });
    expect(loadOf(build, 'hermes').words).toBe(HERMES_WORDS - 5 + 7);
    expect(build.files[0]!.content).toContain('hill0');
    expect(build.skills).toEqual([{ id: 'garden-guide/skills/potato/SKILL.md', version: '0.2.0', sha256: hash(BUNDLED) }]);
  });

  it('refuses a bundled skill whose hash or version the pack does not match', () => {
    const wrongHash = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: '0'.repeat(64) }] }; },
    });
    expect(failureOf(() => compile(wrongHash, { harnesses: ['hermes'] })))
      .toContain('skills.private[0] sha256 does not match the pack pin');
    const wrongVersion = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; },
    });
    rmSync(join(wrongVersion, 'roles/garden-guide/skills/potato/SKILL.md'));
    writeFileSync(join(wrongVersion, 'roles/garden-guide/skills/potato/SKILL.md'), BUNDLED.replace('version: 0.2.0', 'name: potato'));
    expect(failureOf(() => compile(wrongVersion, { harnesses: ['hermes'] })))
      .toContain('skills.private[0]: front matter YAML DUPLICATE_KEY');
  });

  it('reports a bundled skill that is not on disk', () => {
    const dir = tree({
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: '0'.repeat(64) }] }; },
    });
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain('roles/ folder 0 skills.private[0] is missing');
  });
});

describe('skill pins', () => {
  it.each(['&note', '!!str'])('refuses rejected YAML node properties %s without recording an embedded version', property => {
    for (const rootVersion of ['', 'version: 2.0.0\n']) {
      const skill = `---\nmetadata: [${property} "Plan the garden]\nversion: 1.0.0\nend: finish"]\n${rootVersion}---\n\ncore\n`;
      const scanned: string[] = [];
      expect(failureOf(() => compile(tree({ skill }), {
        scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
      }))).toContain('front matter');
      expect(scanned).toEqual([]);
    }
  });

  it.each(['&note', '!!str'])('reads the root version after a %s-quoted flow scalar', property => {
    const metadata = `metadata: [${property} "Plan the garden]\n  version: 1.0.0\n  end: finish"]`;
    expect(skillVersion(`---\n${metadata}\n---\n\ncore\n`)).toBeNull();
    const skill = `---\n${metadata}\nversion: 2.0.0\n---\n\ncore\n`;
    expect(compile(tree({ skill, skillPin: { version: '2.0.0' } })).receipt.skills)
      .toEqual([{ id: 'seasonal-planning', version: '2.0.0', sha256: hash(skill) }]);
  });

  it('accepts standalone sequence indicators in unrelated metadata', () => {
    const skill = '---\nmetadata:\n  -\n    description: Plan the garden.\nversion: 1.0.0\n---\n\ncore\n';
    expect(skillVersion(skill)).toBe('1.0.0');
    expect(compile(tree({ skill })).receipt.skills[0]!.version).toBe('1.0.0');
  });

  it('accepts uppercase shared-skill pins and records the canonical digest', () => {
    const build = compile(tree({ skillPin: { sha256: hash(SKILL).toUpperCase() } }), { harnesses: ['hermes'] });
    expect(build.receipt.skills).toEqual([{ id: 'seasonal-planning', version: '1.0.0', sha256: hash(SKILL) }]);
  });

  it('accepts uppercase bundled-skill pins and records the canonical digest', () => {
    const dir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED).toUpperCase() }] }; },
    });
    expect(compile(dir, { harnesses: ['hermes'] }).receipt.skills)
      .toEqual([{ id: 'garden-guide/skills/potato/SKILL.md', version: '0.2.0', sha256: hash(BUNDLED) }]);
  });

  it('hashes the original UTF-8 skill bytes including line endings and Unicode', () => {
    const content = skillFile('Plan the café garden 🌱.').replaceAll('\n', '\r\n');
    const bytes = Buffer.from(content, 'utf8');
    const dir = tree({ skill: content, skillPin: { sha256: hash(bytes) } });
    const build = compile(dir, { harnesses: ['hermes'] });
    expect(build.receipt.skills[0]!.sha256).toBe(hash(readFileSync(join(dir, 'skills/seasonal-planning/SKILL.md'))));
    expect(build.files[0]!.content).toContain('Plan the café garden 🌱.');
  });

  it.each([0xff, 0xfe, 0xc3])('refuses malformed UTF-8 byte %i despite a pin matching replacement text', byte => {
    const bytes = Buffer.concat([Buffer.from(SKILL), Buffer.from([byte])]);
    const replacementPin = hash(bytes.toString('utf8'));
    expect(hash(bytes)).not.toBe(replacementPin);
    const sharedDir = tree({ skillPin: { sha256: replacementPin } });
    writeFileSync(join(sharedDir, 'skills/seasonal-planning/SKILL.md'), bytes);
    expect(failureOf(() => compile(sharedDir, { harnesses: ['hermes'] }))).toContain('has no SKILL.md');
    const bundledDir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': SKILL },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: replacementPin }] }; },
    });
    writeFileSync(join(bundledDir, 'roles/garden-guide/skills/potato/SKILL.md'), bytes);
    expect(failureOf(() => compile(bundledDir, { harnesses: ['hermes'] }))).toContain('skills.private[0] is missing');
  });

  it('refuses a skill whose content does not match the pack\'s hash', () => {
    expect(failureOf(() => compile(tree({ skillPin: { sha256: '0'.repeat(64) } }))))
      .toContain('roles/ folder 0 skills.shared[0] sha256 does not match the pack pin');
  });

  it('refuses a skill whose version does not match the pack\'s pin', () => {
    expect(failureOf(() => compile(tree({ skillPin: { version: '2.0.0' } }))))
      .toContain('roles/ folder 0 skills.shared[0] version does not match the pack pin');
  });

  it('refuses a skill that names no version, or a version that is not semantic', () => {
    const none = tree({ skill: skillFile(words(5, 'core')).replace('version: 1.0.0\n', '') });
    expect(failureOf(() => compile(none, { harnesses: ['hermes'] })))
      .toContain('roles/ folder 0 skills.shared[0] SKILL.md names no semantic version in its front matter');
    const odd = tree({ skill: skillFile(words(5, 'core')).replace('version: 1.0.0', 'version: latest') });
    expect(failureOf(() => compile(odd, { harnesses: ['hermes'] }))).toContain('names no semantic version');
    expect(skillVersion(SKILL)).toBe('1.0.0');
    expect(skillVersion('---\nversion: "1.2.3"\n---\n\nx\n')).toBe('1.2.3');
    expect(skillVersion('---\nname: none\n---\n\nx\n')).toBeNull();
  });

  it.each([
    'version: 2.0.0 # current release',
    '"version": "2.0.0"',
    "'version': '2.0.0'",
    '"ver\\u0073ion": "2\\u002e0.0"',
    '{name: seasonal-planning, version: 2.0.0}',
    'description: |\n  version: 1.0.0\nversion: 2.0.0',
    'description: >-\n  version: 1.0.0\nversion: 2.0.0',
    'description: "Plan the garden.\n  version: 1.0.0\n  End."\nversion: 2.0.0',
    "description: 'An author''s note.\n  version: 1.0.0\n  End.'\nversion: 2.0.0",
    'metadata:\n  version: 1.0.0\nversion: 2.0.0',
    'metadata: {description: "Quoted text.\n  version: 1.0.0\n  End."}\nversion: 2.0.0',
    'metadata:\n  - description: "Quoted text.\n      version: 1.0.0\n      End."\nversion: 2.0.0',
    'tags: [garden, season]\nversion: 2.0.0',
    'version: &release 2.0.0\nmetadata: *release',
    'metadata: &release 2.0.0\nversion: *release',
    'description: A long description\n  continues on another line.\nversion: 2.0.0',
  ])('accepts YAML mapping metadata: %s', metadata => {
    const skill = `---\n${metadata}\n---\n\n${words(5, 'core')}\n`;
    expect(skillVersion(skill)).toBe('2.0.0');
    expect(compile(tree({ skill, skillPin: { version: '2.0.0' } })).receipt.skills)
      .toEqual([{ id: 'seasonal-planning', version: '2.0.0', sha256: hash(skill) }]);
  });

  it.each([
    'version: 1.0.0\nversion: 2.0.0',
    'version: 1.0.0\n"ver\\u0073ion": 1.0.0',
    'metadata: {name: one, name: two}\nversion: 1.0.0',
    'description: "Unclosed description.\nversion: 1.0.0',
    'description: "Closed" extra\nversion: 1.0.0',
    'version: !unknown 1.0.0',
    'version: !!timestamp 2026-01-01',
    'version: *missing',
    'metadata:\n  a: &a [x, x, x, x, x, x, x, x, x, x]\n  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n  c: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nversion: 1.0.0',
    '<<: {version: 1.0.0}',
    'version: [1.0.0]',
    'version: {value: 1.0.0}',
    'version: true',
    'version: null',
    'version: 1.0',
    'name: [seasonal-planning]\nversion: 1.0.0',
    'description: {text: Garden}\nversion: 1.0.0',
    '[version, 1.0.0]',
    '1.0.0',
    'null',
    '',
    '1: value\nversion: 1.0.0',
    '? [version]\n: 1.0.0',
    '%YAML 1.1\n---\nversion: 1.0.0',
    'version: 1.0.0\n--- # next document\nversion: 2.0.0',
  ])('refuses YAML syntax or field shapes before scanning: %s', metadata => {
    const skill = `---\n${metadata}\n---\n\n${words(5, 'core')}\n`;
    expect(() => skillVersion(skill)).toThrow(PackCompileError);
    const scanned: string[] = [];
    expect(failureOf(() => compile(tree({ skill }), {
      scan: file => { scanned.push(file.path); return { ok: true, reasons: [] }; },
    }))).toContain('front matter');
    expect(scanned).toEqual([]);
  });

  it('uses core schema scalar types and excludes front matter from the compiled prompt', () => {
    const skill = '---\nname: seasonal-planning\ndescription: on\nmetadata: {enabled: yes, disabled: off}\nversion: 1.0.0\n---\n\ncore\n';
    const build = compile(tree({ skill }));
    expect(build.receipt.skills[0]!.version).toBe('1.0.0');
    expect(build.files[0]!.content).not.toContain('enabled: yes');
    expect(build.loads[0]!.parts.find(part => part.name === 'skill seasonal-planning')!.words).toBe(1);
  });

  it('reports YAML positions and field names without echoing values', () => {
    const marker = 'ghp_' + 'EXAMPLE'.repeat(6);
    for (const metadata of [`description: "${marker}`, `version: [${marker}]`, `metadata: !${marker} value\nversion: 1.0.0`]) {
      const skill = `---\n${metadata}\n---\n\ncore\n`;
      const issues = failureOf(() => compile(tree({ skill })));
      expect(issues).toContain('front matter');
      expect(issues).not.toContain(marker);
      expect(issues).not.toContain('EXAMPLE');
    }
  });

  it('pins a bundled skill using its top-level version', () => {
    const skill = BUNDLED.replace('description: Grows underground.', 'description: "Grows underground.\n  version: 1.0.0\n  Harvest in season."');
    const dir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': skill },
      role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(skill) }] }; },
    });
    expect(compile(dir, { harnesses: ['hermes'] }).receipt.skills)
      .toEqual([{ id: 'garden-guide/skills/potato/SKILL.md', version: '0.2.0', sha256: hash(skill) }]);
  });

  it('reports a shared skill that is not on disk', () => {
    const dir = tree();
    rmSync(join(dir, 'skills/seasonal-planning/SKILL.md'));
    expect(failureOf(() => compile(dir, { harnesses: ['hermes'] })))
      .toContain('roles/ folder 0 skills.shared[0] has no SKILL.md');
  });

  it('pins a skill that two roles share once', () => {
    const second = rolePack(SKILL);
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const build = compile(tree({ extra: { 'roles/tomato-guide/role.json': JSON.stringify(second) } }), { harnesses: ['hermes'] });
    expect(build.skills).toEqual([{ id: 'seasonal-planning', version: '1.0.0', sha256: hash(SKILL) }]);
  });

  it('pins distinct bundled skills with the same relative path in different roles', () => {
    const path = 'skills/potato/SKILL.md';
    const secondSkill = BUNDLED.replace('hill0', 'root0');
    const first = rolePack(SKILL, { role: pack => { pack.skills = { shared: [], private: [{ path, sha256: hash(BUNDLED) }] }; } });
    const second = rolePack(SKILL, { role: pack => { pack.skills = { shared: [], private: [{ path, sha256: hash(secondSkill) }] }; } });
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const build = compile(tree({ extra: {
      'roles/garden-guide/role.json': JSON.stringify(first),
      'roles/tomato-guide/role.json': JSON.stringify(second),
      [`roles/garden-guide/${path}`]: BUNDLED,
      [`roles/tomato-guide/${path}`]: secondSkill,
    } }), { harnesses: ['hermes'] });
    expect(build.receipt.skills).toEqual([
      { id: `garden-guide/${path}`, version: '0.2.0', sha256: hash(BUNDLED) },
      { id: `tomato-guide/${path}`, version: '0.2.0', sha256: hash(secondSkill) },
    ]);
  });
});

describe('the build receipt', () => {
  it('records the version, the scanner result, every compiled file and every skill', () => {
    const build = compile(tree());
    expect(build.receipt).toEqual({
      packVersion: '1.0.0',
      scannerResult: { scanned: 4, ok: true, reasons: [] },
      files: [
        { path: 'roles/garden-guide/hermes.md', sha256: hash(build.files[0]!.content) },
        { path: 'roles/garden-guide/paseo.md', sha256: hash(build.files[1]!.content) },
        { path: 'roles/garden-guide/claude.md', sha256: hash(build.files[2]!.content) },
        { path: 'roles/garden-guide/codex.md', sha256: hash(build.files[3]!.content) },
      ],
      skills: [{ id: 'seasonal-planning', version: '1.0.0', sha256: hash(SKILL) }],
      approvedBy: null,
    });
    expect(build.receipt.skills).toEqual(build.skills);
    expect(build.receipt.files.map(entry => entry.sha256)).toEqual(build.files.map(file => file.sha256));
  });

  it('refuses a build when the caller supplies no scanner', () => {
    const input = { sourceDir: tree(), packVersion: '1.0.0' } as CompileInput;
    expect(failureOf(() => compilePacks(input))).toContain('the build requires a scanner');
  });

  it('hashes the compiled text exactly as it is returned', () => {
    const build = compile(tree(), { harnesses: ['hermes'] });
    const file = build.files[0]!;
    expect(file.sha256).toBe(hash(file.content));
    expect(file.content.endsWith('\n')).toBe(true);
  });
});

describe('the scanner gate', () => {
  it('omits values from scanner reasons and exceptions', () => {
    const marker = 'ghp_' + 'EXAMPLE'.repeat(6);
    for (const scan of [
      () => ({ ok: false, reasons: [marker] }),
      () => { throw new Error(marker); },
    ]) {
      const issues = failureOf(() => compile(tree(), { scan }));
      expect(issues).toContain('files[0]');
      expect(issues).not.toContain(marker);
    }
  });

  it('runs the scanner over every compiled file', () => {
    const seen: string[] = [];
    const scan: ScanFile = file => { seen.push(file.path); return { ok: true, reasons: [] }; };
    const build = compile(tree(), { scan });
    expect(seen).toEqual(build.files.map(file => file.path));
    expect(build.receipt.scannerResult).toEqual({ scanned: 4, ok: true, reasons: [] });
  });

  it('refuses a build where a compiled file is flagged', () => {
    const scan: ScanFile = file => (file.harness === 'paseo'
      ? { ok: false, reasons: ['it would be ignored here', 'an unlisted tool name'] } : { ok: true, reasons: [] });
    const issues = failureOf(() => compile(tree(), { scan }));
    expect(issues).toContain('files[1]: the scanner flagged it at reasons[0], reasons[1]');
    expect(issues).not.toContain('hermes.md');
  });

  it('refuses a file the scanner flags without saying why', () => {
    expect(failureOf(() => compile(tree(), { scan: () => ({ ok: false, reasons: [] }) })))
      .toContain('the scanner flagged it without a reason');
  });

  it('refuses a build where the scanner itself fails', () => {
    const scan: ScanFile = file => { if (file.harness === 'claude') throw new Error('the scanner is not running'); return { ok: true, reasons: [] }; };
    expect(failureOf(() => compile(tree(), { scan })))
      .toContain('files[2]: the scanner could not check it');
  });

  it.each([
    { ok: true, reasons: ['the file would be ignored'] },
    { ok: true }, { ok: true, reasons: 'ignored' }, { ok: true, reasons: [42] },
    undefined, null, Promise.resolve({ ok: true, reasons: [] }),
  ])('refuses an inconsistent or malformed scanner verdict: %j', verdict => {
    expect(failureOf(() => compile(tree(), { scan: (() => verdict) as ScanFile }))).toContain('files[');
  });

  it('prevents the scanner from changing the compiled file after it was hashed', () => {
    const scan: ScanFile = file => {
      (file as { content: string }).content = 'Changed instructions';
      return { ok: true, reasons: [] };
    };
    expect(failureOf(() => compile(tree(), { scan }))).toContain('the scanner could not check it');
  });

  it('collects every file it would refuse, and reports the load of the ones it took', () => {
    const scan: ScanFile = file => ({ ok: file.roleId === 'garden-guide', reasons: file.roleId === 'garden-guide' ? [] : ['unknown role'] });
    const second = rolePack(SKILL);
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const issues = failureOf(() => compile(tree({ extra: { 'roles/tomato-guide/role.json': JSON.stringify(second) } }), { harnesses: ['hermes'], scan }));
    expect(issues).toContain('files[1]: the scanner flagged it at reasons[0]');
    expect(issues).not.toContain('roles/garden-guide/hermes.md');
  });
});

describe('trim records for shorter text', () => {
  it.each(['shared', 'bundled'])('requires evidence when removing one duplicate %s skill occurrence', kind => {
    const path = 'skills/potato/SKILL.md';
    const dir = tree({
      extra: kind === 'bundled' ? { [`roles/garden-guide/${path}`]: BUNDLED } : {},
      role: pack => {
        if (kind === 'bundled') pack.skills = { shared: [], private: [
          { path, sha256: hash(BUNDLED) }, { path, sha256: hash(BUNDLED) },
        ] };
        else {
          const shared = (pack.skills as { shared: unknown[] }).shared;
          shared.push(shared[0]);
        }
      },
    });
    const before = compile(dir);
    const currentDefault = defaultFrom(before);
    expect(compile(dir, { currentDefault }).defaultEligible).toBe(true);
    const pack = before.roles['garden-guide']!;
    const skills = { shared: pack.skills.shared.slice(0, 1), private: pack.skills.private.slice(0, 1) };
    writeFiles(dir, { 'roles/garden-guide/role.json': JSON.stringify({ ...pack, skills }) });
    const after = compile(dir, { currentDefault });
    expect(after.loads[0]!.words).toBe(before.loads[0]!.words - (kind === 'bundled' ? 7 : 5));
    expect(after.defaultEligible).toBe(false);
    expect(after.trimIssues).toEqual(HARNESSES.map((_, index) =>
      `currentDefault.roles[${index}] is shorter than the current default and has no trim record`));
    const trims = HARNESSES.map(harness => trimRecord(`role:garden-guide/${harness}`));
    expect(compile(dir, { currentDefault, trims }).defaultEligible).toBe(true);
    expect(compile(dir, { currentDefault, trims: trims.map(record => ({ ...record, parseFailuresChecked: false })) })
      .defaultEligible).toBe(false);
    writeFiles(dir, { 'roles/garden-guide/role.json': JSON.stringify({ ...pack, skills, contract: words(40, 'contract') }) });
    expect(compile(dir, { currentDefault }).defaultEligible).toBe(false);
  });

  it.each(['role', 'skill', 'budget'])('omits credential-bearing trim keys and values for %s changes', kind => {
    const marker = 'ghp_' + 'EXAMPLE'.repeat(6);
    const subject = kind === 'role' ? 'role:garden-guide/hermes'
      : kind === 'skill' ? 'skill:seasonal-planning' : 'budget:garden-guide';
    const currentDefault = defaultLoad({
      roles: kind === 'role' ? [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 1 }] : [],
      skills: kind === 'skill' ? [{ skillId: 'seasonal-planning', words: 40 }] : [],
      budgets: kind === 'budget' ? [{ roleId: 'garden-guide', words: 80 }] : [],
    });
    const dir = tree({ budgets: { 'garden-guide': { words: 60 } } });
    const label = kind === 'budget' ? 'budgets.json entry 0' : `currentDefault.${kind === 'role' ? 'roles' : 'skills'}[0]`;
    for (const over of [{ [marker]: marker }, { suite: marker }, { models: [marker] }]) {
      const run = () => compile(dir, {
        harnesses: ['hermes'], currentDefault, trims: [trimRecord(subject, over)],
      });
      const issues = kind === 'budget' ? failureOf(run) : run().trimIssues.join('\n');
      expect(issues).toContain(`${label}: trim record`);
      expect(issues).not.toContain(marker);
      expect(issues).not.toContain('EXAMPLE');
    }
  });

  it('omits credential-shaped subjects from trim diagnostics', () => {
    const marker = SK_PROJ + 'a'.repeat(24);
    const removedSkill = compile(tree(), {
      harnesses: ['hermes'], currentDefault: defaultLoad({ skills: [{ skillId: marker, words: 5 }] }),
    });
    expect(removedSkill.defaultEligible).toBe(false);
    expect(removedSkill.trimIssues).toEqual(['currentDefault.skills[0] is shorter than the current default and has no trim record']);
    expect(removedSkill.trimIssues.join('\n')).not.toContain(marker);
    const dir = tree({ budgets: { [marker]: { words: 60 } } });
    const currentDefault = defaultLoad({ budgets: [{ roleId: marker, words: 80 }] });
    for (const trims of [[], [trimRecord(`budget:${marker}`)]]) {
      const issues = failureOf(() => compile(dir, { harnesses: ['hermes'], currentDefault, trims }));
      expect(issues).toContain('budgets.json entry 0');
      expect(issues).not.toContain(marker);
    }
  });

  it.each(['shared', 'shared by another role', 'bundled'])('requires role evidence when removing a skill %s', kind => {
    const path = 'skills/potato/SKILL.md';
    const second = rolePack(SKILL);
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const dir = tree({
      extra: kind === 'bundled' ? { [`roles/garden-guide/${path}`]: BUNDLED }
        : kind === 'shared by another role' ? { 'roles/tomato-guide/role.json': JSON.stringify(second) } : {},
      role: pack => {
        if (kind === 'bundled') pack.skills = { shared: [], private: [{ path, sha256: hash(BUNDLED) }] };
      },
    });
    const before = compile(dir);
    const currentDefault = defaultFrom(before);
    const pack = before.roles['garden-guide']!;
    writeFiles(dir, { 'roles/garden-guide/role.json': JSON.stringify({ ...pack, skills: { shared: [], private: [] } }) });
    const build = compile(dir, { currentDefault });
    expect(build.loads.find(load => load.roleId === 'garden-guide')!.words)
      .toBe(before.loads.find(load => load.roleId === 'garden-guide')!.words - (kind === 'bundled' ? 7 : 5));
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toEqual(HARNESSES.map((_, index) =>
      `currentDefault.roles[${index}] is shorter than the current default and has no trim record`));
    const trims = HARNESSES.map(harness => trimRecord(`role:garden-guide/${harness}`));
    expect(compile(dir, { currentDefault, trims }).defaultEligible).toBe(true);
    expect(compile(dir, { currentDefault, trims: trims.map(record => ({ ...record, parseFailuresChecked: false })) })
      .defaultEligible).toBe(false);
    expect(compile(dir, { currentDefault, trims: trims.map(record => ({ ...record, scoreAfter: 0.5 })) })
      .defaultEligible).toBe(false);
  });

  it('requires evidence for a removed core even if role text and replacement skills grow', () => {
    const dir = tree();
    const before = compile(dir, { harnesses: ['hermes'] });
    const replacement = skillFile(words(20, 'replacement'));
    writeFiles(dir, {
      'skills/crop-planning/SKILL.md': replacement,
      'roles/garden-guide/role.json': JSON.stringify({
        ...before.roles['garden-guide']!, contract: words(20, 'contract'),
        skills: { shared: [{ id: 'crop-planning', version: '1.0.0', sha256: hash(replacement) }], private: [] },
      }),
    });
    const currentDefault = defaultFrom(before);
    const build = compile(dir, { harnesses: ['hermes'], currentDefault });
    expect(build.loads[0]!.words).toBeGreaterThan(before.loads[0]!.words);
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toEqual(['currentDefault.roles[0] is shorter than the current default and has no trim record']);
  });

  it('requires evidence for a removed skill in older default measurements without role skill ids', () => {
    const dir = tree({ role: pack => { pack.skills = { shared: [], private: [] }; } });
    const currentDefault = defaultLoad({ skills: [{ skillId: 'seasonal-planning', words: 5 }] });
    const build = compile(dir, { harnesses: ['hermes'], currentDefault });
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toEqual(['currentDefault.skills[0] is shorter than the current default and has no trim record']);
    expect(compile(dir, { harnesses: ['hermes'], currentDefault, trims: [trimRecord('skill:seasonal-planning')] })
      .defaultEligible).toBe(true);
  });

  it('checks older per-role measurements even if another role retains the shared core', () => {
    const second = rolePack(SKILL);
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const dir = tree({
      role: pack => { pack.skills = { shared: [], private: [] }; },
      extra: { 'roles/tomato-guide/role.json': JSON.stringify(second) },
    });
    const currentDefault = defaultLoad({
      roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS }],
      skills: [{ skillId: 'seasonal-planning', words: 5 }],
    });
    const build = compile(dir, { harnesses: ['hermes'], currentDefault });
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toEqual(['currentDefault.roles[0] is shorter than the current default and has no trim record']);
    expect(compile(dir, { harnesses: ['hermes'], currentDefault, trims: [trimRecord('role:garden-guide/hermes')] })
      .defaultEligible).toBe(true);
  });

  it('records skill composition per role and keeps unchanged or added cores eligible', () => {
    const before = compile(tree());
    expect(before.loads.every(load => load.skillIds.join(',') === 'seasonal-planning')).toBe(true);
    const currentDefault = defaultFrom(before);
    expect(compile(tree(), { currentDefault }).defaultEligible).toBe(true);
    const dir = tree({
      extra: { 'roles/garden-guide/skills/potato/SKILL.md': BUNDLED },
      role: pack => {
        (pack.skills as { private: unknown[] }).private = [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }];
      },
    });
    expect(compile(dir, { currentDefault }).defaultEligible).toBe(true);
  });

  it('compares removals only for roles and harnesses being built', () => {
    const second = rolePack(SKILL, { role: pack => { pack.skills = { shared: [], private: [{ path: 'skills/potato/SKILL.md', sha256: hash(BUNDLED) }] }; } });
    (second.identity as Record<string, unknown>).id = 'tomato-guide';
    const dir = tree({ extra: {
      'roles/tomato-guide/role.json': JSON.stringify(second),
      'roles/tomato-guide/skills/potato/SKILL.md': BUNDLED,
    } });
    const currentDefault = defaultFrom(compile(dir));
    const build = compile(dir, { roles: ['garden-guide'], harnesses: ['hermes'], currentDefault });
    expect(build.defaultEligible).toBe(true);
    expect(build.trimIssues).toEqual([]);
  });

  it('lets a version with nothing shorter stand as the default', () => {
    const build = compile(tree(), { currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_OTHER_WORDS }] }) });
    expect(build.defaultEligible).toBe(true);
    expect(build.trimIssues).toEqual([]);
  });

  it('refuses to mark the version the default when a role got shorter without a record', () => {
    const build = compile(tree(), {
      harnesses: ['hermes'],
      currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 40 }] }),
    });
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toEqual(['currentDefault.roles[0] is shorter than the current default and has no trim record']);
  });

  it('marks the version the default when a tie goes to the shorter text', () => {
    const run = (scoreAfter: number, margin: number) => compile(tree(), {
      harnesses: ['hermes'],
      currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 40 }] }),
      trims: [trimRecord('role:garden-guide/hermes', { scoreBefore: 0.9, scoreAfter, margin })],
    });
    expect(run(0.88, 0.02).defaultEligible).toBe(true);   // the same score, within the margin
    expect(run(0.87, 0.03).defaultEligible).toBe(true);   // exactly on the margin
    expect(run(0.95, 0.02).defaultEligible).toBe(true);   // better than before
    expect(run(0.85, 0.02).defaultEligible).toBe(false);  // worse than the tie allows
    expect(run(0.85, 0.02).trimIssues[0]).toContain('the longer text stands');
  });

  it('requires each of the three failure checks', () => {
    for (const field of ['askingFailuresChecked', 'decliningFailuresChecked', 'parseFailuresChecked'] as const) {
      const build = compile(tree(), {
        harnesses: ['hermes'],
        currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 40 }] }),
        trims: [trimRecord('role:garden-guide/hermes', { [field]: false })],
      });
      expect(build.defaultEligible, field).toBe(false);
      expect(build.trimIssues.join('\n'), field).toMatch(/did not check (asking|declining|parsing) failures/);
    }
  });

  it('refuses a record with no suite, no models or no rule map hash', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ suite: '' }, /trim record suite must not be empty/],
      [{ models: [] }, /trim record models must name at least one model/],
      [{ ruleMapSha256: 'z'.repeat(64) }, /trim record ruleMapSha256 must be 64 hex characters/],
      [{ scoreAfter: -1 }, /trim record scoreAfter/],
      [{ extra: true }, /trim record contains unknown fields/],
    ];
    for (const [over, expected] of cases) {
      const build = compile(tree(), {
        harnesses: ['hermes'],
        currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 40 }] }),
        trims: [trimRecord('role:garden-guide/hermes', over as Partial<TrimRecord>)],
      });
      expect(build.defaultEligible, JSON.stringify(over)).toBe(false);
      expect(build.trimIssues.join('\n'), JSON.stringify(over)).toMatch(expected);
    }
  });

  it('refuses a skill that got shorter without its own record', () => {
    const currentDefault = defaultLoad({ skills: [{ skillId: 'seasonal-planning', words: 40 }] });
    const build = compile(tree(), { harnesses: ['hermes'], currentDefault });
    expect(build.trimIssues).toEqual(['currentDefault.skills[0] is shorter than the current default and has no trim record']);
    expect(compile(tree(), { harnesses: ['hermes'], currentDefault, trims: [trimRecord('skill:seasonal-planning')] }).defaultEligible).toBe(true);
  });

  it.each([114, ROLES_PACK_LIMITS.path])('accepts trim evidence for a bundled skill with a %i-character path', length => {
    const prefix = 'skills/';
    const suffix = 'SKILL.md';
    const segment = 'garden.x/';
    const segments = Math.floor((length - prefix.length - suffix.length) / segment.length);
    const path = prefix + segment.repeat(segments) + 'x'.repeat(length - prefix.length - suffix.length - segments * segment.length) + suffix;
    const skillId = `garden-guide/${path}`;
    const subject = `skill:${skillId}`;
    expect(path).toHaveLength(length);
    expect(subject.length).toBeGreaterThan(ROLES_PACK_LIMITS.identifier);
    const dir = tree({
      extra: { [`roles/garden-guide/${path}`]: BUNDLED },
      role: pack => { pack.skills = { shared: [], private: [{ path, sha256: hash(BUNDLED) }] }; },
    });
    const currentDefault = defaultLoad({ skills: [{ skillId, words: 40 }] });
    expect(compile(dir, { harnesses: ['hermes'], currentDefault }).defaultEligible).toBe(false);
    const build = compile(dir, { harnesses: ['hermes'], currentDefault, trims: [trimRecord(subject)] });
    expect(build.defaultEligible).toBe(true);
    expect(build.trimIssues).toEqual([]);
  });

  it('lets a budget step down only with a record', () => {
    const currentDefault = defaultLoad({ budgets: [{ roleId: 'garden-guide', words: 80 }] });
    const step = { harnesses: ['hermes'] as const };
    expect(failureOf(() => compile(tree({ budgets: { 'garden-guide': { words: 60 } } }), { ...step, currentDefault })))
      .toContain('budgets.json entry 0 is shorter than the current default and has no trim record');
    expect(compile(tree({ budgets: { 'garden-guide': { words: 60 } } }), { ...step, currentDefault, trims: [trimRecord('budget:garden-guide')] }).defaultEligible).toBe(true);
    expect(compile(tree({ budgets: { 'garden-guide': { words: 90 } } }), { ...step, currentDefault }).defaultEligible).toBe(true);
  });

  it('refuses a budget stepdown supported by an incomplete or losing record', () => {
    const currentDefault = defaultLoad({ budgets: [{ roleId: 'garden-guide', words: 80 }] });
    for (const over of [{ parseFailuresChecked: false }, { scoreAfter: 0.5 }]) {
      expect(failureOf(() => compile(tree({ budgets: { 'garden-guide': { words: 60 } } }), {
        harnesses: ['hermes'], currentDefault, trims: [trimRecord('budget:garden-guide', over)],
      }))).toContain('budgets.json entry 0');
    }
  });

  it('detects a shorter role even when shared rules grow by more', () => {
    const dir = tree({
      rules: { hermes: words(100, 'rules') },
      role: pack => { pack.contract = words(2, 'contract'); },
    });
    const build = compile(dir, {
      harnesses: ['hermes'],
      currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS }] }),
    });
    expect(build.loads[0]!.words).toBeGreaterThan(HERMES_WORDS);
    expect(build.defaultEligible).toBe(false);
    expect(build.trimIssues).toContain('currentDefault.roles[0] is shorter than the current default and has no trim record');
  });

  it('treats a score on the margin as a tie despite rounding', () => {
    const build = compile(tree(), {
      harnesses: ['hermes'],
      currentDefault: defaultLoad({ roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 1 }] }),
      trims: [trimRecord('role:garden-guide/hermes', { scoreBefore: 0.8, scoreAfter: 0.7, margin: 0.1 })],
    });
    expect(build.defaultEligible).toBe(true);
  });

  it('wants one record per change', () => {
    const currentDefault = defaultLoad({
      roles: [{ roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS + 40 }],
      skills: [{ skillId: 'seasonal-planning', words: 40 }],
    });
    const build = compile(tree(), {
      harnesses: ['hermes'], currentDefault,
      trims: [trimRecord('role:garden-guide/hermes'), trimRecord('role:garden-guide/hermes', { suite: 'other' })],
    });
    expect(build.trimIssues.join('\n')).toContain('currentDefault.roles[0] has 2 trim records where one is expected');
    expect(build.trimIssues.join('\n')).toContain('currentDefault.skills[0] is shorter');
  });

  it('ignores records for text that did not get shorter', () => {
    const build = compile(tree(), { harnesses: ['hermes'], currentDefault: defaultLoad(), trims: [trimRecord('skill:another-skill')] });
    expect(build.trimIssues).toEqual([]);
    expect(build.defaultEligible).toBe(true);
  });

  it('compares each harness on its own', () => {
    const build = compile(tree(), {
      harnesses: ['hermes', 'paseo'],
      currentDefault: defaultLoad({ roles: [
        { roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS },
        { roleId: 'garden-guide', harness: 'paseo', words: ROLE_OTHER_WORDS + 1 },
      ] }),
    });
    expect(build.trimIssues).toEqual(['currentDefault.roles[1] is shorter than the current default and has no trim record']);
    expect(build.defaultEligible).toBe(false);
    const evidenced = compile(tree(), {
      harnesses: ['hermes', 'paseo'],
      currentDefault: defaultLoad({ roles: [
        { roleId: 'garden-guide', harness: 'hermes', words: ROLE_HERMES_WORDS },
        { roleId: 'garden-guide', harness: 'paseo', words: ROLE_OTHER_WORDS + 1 },
      ] }),
      trims: [trimRecord('role:garden-guide/paseo')],
    });
    expect(evidenced.defaultEligible).toBe(true);
  });
});

it('makes compiler measurements and recorded budgets available to the production settings reader', async () => {
  const dir = tree({ budgets: { 'garden-guide': { words: 100 } } });
  const build = compile(dir);
  const path = join(dir, 'build.json'); writeFileSync(path, JSON.stringify(build));
  const config = parseConfig({ publicOrigin: 'https://example.com', stateDir: dir, settings: { packBuildFile: path } });
  const loads = await productionSettingsReaders(config).roleLoads!() as Array<{ role: string; harness: string; words: number; tokens: number; targetWords: number; budgetWords: number; parts: { shared: number; dispatch: number; role: number; skills: number } }>;
  expect(loads).toHaveLength(HARNESSES.length);
  expect(loads.find(load => load.harness === 'hermes')).toEqual({ role: 'garden-guide', harness: 'hermes', words: HERMES_WORDS,
    tokens: estimateTokens(HERMES_WORDS), targetWords: PACK_BUDGETS.roleTargetWords, budgetWords: 100,
    parts: { shared: 10, dispatch: 20, role: ROLE_HERMES_WORDS, skills: 5 } });
  expect(JSON.stringify(loads)).not.toMatch(/persona0|core0|author|instructions/);
});
