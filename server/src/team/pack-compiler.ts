import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { LineCounter, isMap, isScalar, parseAllDocuments } from 'yaml';
import {
  PACK_HARNESSES, TrimRecordSchema, hasSecret, isSemanticVersion, parseRolesPack, validateRolesPack, RolesPackError,
  type PackHarness, type RolesPack, type TrimRecord,
} from '../../../shared/roles-pack.js';

// The roles-pack compiler. It reads pack sources from a folder, builds one prompt file per
// role per harness, measures what each role costs the harness that runs it, and records the
// pins and the build receipt. Sources are plain files read by path; nothing here talks to a
// running service, and the scanner that vets the compiled files is passed in by the caller.
//
// The source folder looks like this:
//   roles/<role-id>/role.json          the role pack
//   shared/rules/<harness>.md          the rules every role on that harness starts with
//   shared/dispatch/<harness>.md       the dispatch protocol for that harness
//   skills/<skill-id>/SKILL.md         an allowlisted skill (its references/ folder is not read)
//   budgets.json                       optional: { "<role-id>": { "words": <budget> } }
// A role's own bundled skills are read from under its own folder, at the path the pack gives.

/** Word and token budgets the build enforces. */
export const PACK_BUDGETS = {
  /** Core rules one skill may carry. Above this the build refuses it. */
  skillCoreWords: 1_500,
  /** Core rules where a skill starts to warn, below the cap. */
  skillWarnWords: 500,
  /** Words per role per harness that the build warns above. */
  roleTargetWords: 4_000,
  /** Rough estimate of the tokens a word of rules text costs. */
  tokensPerWord: 1.35,
} as const;

export class PackCompileError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(issues.join('\n'));
    this.name = 'PackCompileError';
  }
}

/** A prompt file the build produced. */
export interface CompiledFile {
  /** Where it lands in the build, e.g. roles/garden-guide/hermes.md. */
  path: string;
  content: string;
  sha256: string;
  roleId: string;
  harness: PackHarness;
}

/** What the build pins a skill to. */
export interface SkillPin {
  id: string;
  version: string;
  sha256: string;
}

/** What one harness's compiled prompt costs one role. */
export interface RoleLoad {
  roleId: string;
  harness: PackHarness;
  words: number;
  tokens: number;
  /** The role's own persona, contract and harness overlay, without shared rules or skills. */
  roleWords: number;
  /** Shared ids and role-qualified bundled paths included in this prompt. */
  skillIds: string[];
  /** The same total, section by section. */
  parts: Array<{ name: string; words: number }>;
  targetWords: number;
  budgetWords: number | null;
}

/** How the pack version that is the default today measured. */
export interface DefaultLoad {
  /** RoleLoad.roleWords and skillIds. Older snapshots without skillIds use the global cores. */
  roles: Array<{ roleId: string; harness: PackHarness; words: number; skillIds?: readonly string[] }>;
  skills: Array<{ skillId: string; words: number }>;
  budgets: Array<{ roleId: string; words: number }>;
}

/** The scanner's verdict on one compiled file. */
export interface ScanVerdict {
  ok: boolean;
  reasons: string[];
}
/** Runs over every compiled file; a file it would ignore or flag fails the build. */
export type ScanFile = (file: Readonly<CompiledFile>) => ScanVerdict;

export interface CompileInput {
  /** Folder holding the pack sources. */
  sourceDir: string;
  /** The version this build releases. */
  packVersion: string;
  /** Role ids to build; every folder under roles/ when omitted. */
  roles?: readonly string[];
  /** Harnesses to build; all of them when omitted. */
  harnesses?: readonly PackHarness[];
  scan: ScanFile;
  /** Words per role per harness that the build warns above. */
  targetWords?: number;
  /** Measurements of the pack version that is the default today, for the trim check. */
  currentDefault?: DefaultLoad;
  /** Evidence for text that got shorter. */
  trims?: readonly TrimRecord[];
}

export interface BuildReceipt {
  packVersion: string;
  scannerResult: { scanned: number; ok: boolean; reasons: string[] };
  files: Array<{ path: string; sha256: string }>;
  skills: SkillPin[];
  /** Recorded by whoever approves the version, after the build. */
  approvedBy: string | null;
}

export interface PackBuild {
  packVersion: string;
  /** Every built pack, with its measured load written in. */
  roles: Record<string, RolesPack>;
  files: CompiledFile[];
  loads: RoleLoad[];
  /** Every skill the build read, pinned by id, version and hash. */
  skills: SkillPin[];
  warnings: string[];
  /** False when text got shorter without the evidence a trim record carries. */
  defaultEligible: boolean;
  trimIssues: string[];
  receipt: BuildReceipt;
}

/** Words in text: whitespace-separated runs, markdown counted as it is written. */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter(word => word.length > 0).length;
}

export function estimateTokens(words: number): number {
  return Math.round(words * PACK_BUDGETS.tokensPerWord);
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontMatterFields(source: string): Record<string, unknown> {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, {
    version: '1.2', schema: 'core', merge: false, resolveKnownTags: false,
    uniqueKeys: true, strict: true, prettyErrors: false, logLevel: 'silent', lineCounter,
  });
  if (documents.length !== 1) throw new PackCompileError(['front matter must contain one YAML mapping']);
  const document = documents[0]!;
  const issues = [...document.errors, ...document.warnings].map(issue => {
    const { line, col } = lineCounter.linePos(issue.pos[0]);
    return `front matter YAML ${issue.code} at line ${line + 1}, column ${col}`;
  });
  if (document.directives.yaml.version !== '1.2') issues.push('front matter must use YAML 1.2 core schema');
  if (issues.length > 0) throw new PackCompileError(issues);
  if (!isMap(document.contents)) throw new PackCompileError(['front matter must be a plain mapping']);
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') {
      throw new PackCompileError(['front matter must contain string field names without merge keys']);
    }
  }
  let fields: unknown;
  try {
    fields = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new PackCompileError(['front matter YAML aliases could not be resolved']);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || Object.getPrototypeOf(fields) !== Object.prototype) {
    throw new PackCompileError(['front matter must be a plain mapping']);
  }
  const mapping = fields as Record<string, unknown>;
  for (const field of ['name', 'description', 'version']) {
    if (Object.hasOwn(mapping, field) && typeof mapping[field] !== 'string') {
      throw new PackCompileError([`front matter ${field} must be text`]);
    }
  }
  return mapping;
}

function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The front matter block a skill file starts with, or '' when it has none. */
export function skillFrontMatter(text: string): string {
  return FRONT_MATTER.exec(text)?.[0] ?? '';
}

/** A skill's core rules: its SKILL.md without the front matter. Files under references/ are
 *  not part of the core, so callers never pass them in. */
export function skillCoreText(text: string): string {
  return text.slice(skillFrontMatter(text).length);
}

/** The semantic version a skill names, or null when absent; malformed metadata is refused. */
export function skillVersion(text: string): string | null {
  const source = FRONT_MATTER.exec(text)?.[1];
  if (source === undefined) return null;
  const fields = frontMatterFields(source);
  const version = Object.hasOwn(fields, 'version') ? fields.version : undefined;
  return typeof version === 'string' && isSemanticVersion(version) && !hasSecret(version) ? version : null;
}

function sourceSkillVersion(text: string, label: string): string | null {
  try {
    return skillVersion(text);
  } catch (error) {
    throw new PackCompileError(error instanceof PackCompileError
      ? error.issues.map(issue => `${label}: ${issue}`) : [`${label}: front matter YAML could not be read`]);
  }
}

export interface SkillCoreLoad {
  words: number;
  tokens: number;
  /** Over the target and under the cap. */
  warning: string | null;
  /** Over the cap, which the build refuses. */
  refused: string | null;
}

/** The size of a skill's core rules against the per-skill budget. */
export function measureSkillCore(text: string): SkillCoreLoad {
  const words = countWords(skillCoreText(text));
  return {
    words,
    tokens: estimateTokens(words),
    warning: words > PACK_BUDGETS.skillWarnWords && words <= PACK_BUDGETS.skillCoreWords
      ? `core rules are ${words} words, above the ${PACK_BUDGETS.skillWarnWords}-word target`
      : null,
    refused: words > PACK_BUDGETS.skillCoreWords
      ? `core rules are ${words} words, over the ${PACK_BUDGETS.skillCoreWords}-word cap`
      : null,
  };
}

interface Source {
  content: string;
  sha256: string;
}

function resolveInside(file: string, root: string): string | null {
  try {
    const resolved = realpathSync(file);
    const path = relative(realpathSync(root), resolved);
    if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function readSource(file: string, root: string): Source | null {
  try {
    const resolved = resolveInside(file, root);
    if (!resolved || !statSync(resolved).isFile()) return null;
    const bytes = readFileSync(resolved);
    if (!isUtf8(bytes)) return null;
    return { content: bytes.toString('utf8'), sha256: sha256Of(bytes) };
  } catch {
    return null;
  }
}

/** The recorded budget per role, from budgets.json in the source folder. */
function readBudgets(sourceDir: string, issues: string[]): Record<string, { words: number }> {
  const file = join(sourceDir, 'budgets.json');
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    const source = readSource(file, sourceDir);
    if (!source) throw new Error('the budget file cannot be read');
    parsed = JSON.parse(source.content) as unknown;
  } catch {
    issues.push(`${relative(sourceDir, file)} is not valid JSON`);
    return {};
  }
  const budgets: Record<string, { words: number }> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push(`${relative(sourceDir, file)} must map role ids to { words: <number> }`);
    return {};
  }
  for (const [index, [roleId, entry]] of Object.entries(parsed as Record<string, unknown>).entries()) {
    const words = (entry as { words?: unknown })?.words;
    if (typeof words !== 'number' || !Number.isFinite(words) || words < 1) {
      issues.push(`budgets.json entry ${index} must give "words" as a positive number`);
    } else {
      budgets[roleId] = { words: Math.floor(words) };
    }
  }
  return budgets;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface RoleSource {
  id: string;
  label: string;
}

function roleIds(sourceDir: string, wanted: readonly string[] | undefined, issues: string[]): RoleSource[] {
  const rolesDir = join(sourceDir, 'roles');
  if (wanted) {
    if (wanted.length === 0) issues.push('the build requires at least one role');
    const ids: RoleSource[] = [];
    for (const [index, id] of wanted.entries()) {
      const label = `roles[${index}]`;
      const previous = ids.find(role => role.id === id);
      if (!SLUG.test(id)) issues.push(`${label} is not a folder name the compiler can read`);
      else if (previous) issues.push(`${label} must not repeat ${previous.label}`);
      else if (!existsSync(join(rolesDir, id))) issues.push(`${label} has no folder under roles/`);
      else ids.push({ id, label });
    }
    return ids;
  }
  let entries: string[];
  try {
    entries = readdirSync(rolesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    issues.push(`${relative(sourceDir, rolesDir)} is missing or cannot be read`);
    return [];
  }
  const ids: RoleSource[] = [];
  if (entries.length === 0) issues.push('the build requires at least one role');
  for (const [index, entry] of entries.sort().entries()) {
    if (SLUG.test(entry)) ids.push({ id: entry, label: `roles/ folder ${index}` });
    else issues.push(`roles/ folder ${index} is not named with a lowercase slug`);
  }
  return ids;
}

function readPack(file: string, root: string, label: string, issues: string[]): RolesPack | null {
  const source = readSource(file, root);
  if (!source) {
    issues.push(`${label} has no role.json`);
    return null;
  }
  try {
    return parseRolesPack(source.content);
  } catch (error) {
    const list = error instanceof RolesPackError ? error.issues : ['the role pack could not be read'];
    issues.push(...list.map(issue => issue === 'rolesPack must contain valid JSON'
      ? `${label} role.json is not valid JSON` : `${label} role.json: ${issue}`));
    return null;
  }
}

function joinSections(sections: string[]): string {
  return `${sections.map(section => section.trim()).filter(section => section !== '').join('\n\n')}\n`;
}

/** One role's rules on one harness: shared rules, dispatch protocol, the role's own section
 *  (persona, contract and its overlay for that harness) and each allowlisted skill's core. */
function compileRole(harness: PackHarness, pack: RolesPack, source: {
  shared: string; dispatch: string; skills: ReadonlyArray<{ name: string; text: string }>;
}): { content: string; parts: Array<{ name: string; words: number }> } {
  const roleSection = [pack.instructions.persona, pack.contract, pack.instructions.overlays?.[harness] ?? ''].join('\n\n');
  const sections = [
    { name: 'shared rules', text: source.shared },
    { name: 'dispatch protocol', text: source.dispatch },
    { name: 'role section', text: roleSection },
    ...source.skills,
  ];
  const content = joinSections(sections.map(section => section.text));
  return { content, parts: sections.map(section => ({ name: section.name, words: countWords(section.text) })) };
}

/** Why a trim record does not carry the evidence it is supposed to. */
function trimRecordIssues(label: string, record: TrimRecord): string[] {
  const check = TrimRecordSchema.safeParse(record);
  if (!check.success) {
    return check.error.issues.map(issue => issue.code === 'unrecognized_keys'
      ? `${label}: trim record contains unknown fields`
      : `${label}: trim record ${issue.path.length ? `${issue.path.join('.')} ` : ''}${issue.message}`);
  }
  const issues: string[] = [];
  for (const [field, failure] of [
    ['askingFailuresChecked', 'asking'], ['decliningFailuresChecked', 'declining'], ['parseFailuresChecked', 'parsing'],
  ] as const) {
    if (!check.data[field]) issues.push(`${label}: trim record did not check ${failure} failures`);
  }
  // A score on the margin is a tie even when floating-point rounding shifts the boundary.
  const tolerance = Number.EPSILON * Math.max(1, check.data.scoreBefore, check.data.scoreAfter, check.data.margin) * 4;
  if (check.data.scoreBefore - check.data.scoreAfter > check.data.margin + tolerance) {
    issues.push(`${label}: trim record scoreAfter is below scoreBefore beyond margin, so the longer text stands`);
  }
  return issues;
}

/** Every skill the build read, with its core measurement. */
type SkillRecord = SkillPin & { words: number };

function recordSkill(skills: Map<string, SkillRecord>, id: string, label: string, version: string, source: Source,
  issues: string[], warnings: string[]): void {
  const seen = skills.get(id);
  if (seen) {
    if (seen.sha256 !== source.sha256) issues.push(`${label} appears with two different contents`);
    return;
  }
  const load = measureSkillCore(source.content);
  if (load.refused) issues.push(`${label} ${load.refused}`);
  else if (load.warning) warnings.push(`skill "${id}" ${load.warning}`);
  skills.set(id, { id, version, sha256: source.sha256, words: load.words });
}

function runScanner(files: readonly CompiledFile[], scan: ScanFile): BuildReceipt['scannerResult'] {
  if (typeof scan !== 'function') return { scanned: 0, ok: false, reasons: ['the build requires a scanner'] };
  const reasons: string[] = [];
  for (const [index, file] of files.entries()) {
    let verdict: ScanVerdict;
    try {
      verdict = scan(Object.freeze({ ...file }));
    } catch {
      reasons.push(`files[${index}]: the scanner could not check it`);
      continue;
    }
    if (typeof verdict?.ok !== 'boolean' || !Array.isArray(verdict.reasons) ||
      !verdict.reasons.every(reason => typeof reason === 'string')) {
      reasons.push(`files[${index}]: the scanner returned an invalid verdict`);
    } else if (!verdict.ok || verdict.reasons.length > 0) {
      const detail = verdict.reasons.length
        ? `the scanner flagged it at ${verdict.reasons.map((_, index) => `reasons[${index}]`).join(', ')}`
        : 'the scanner flagged it without a reason';
      reasons.push(`files[${index}]: ${detail}`);
    }
  }
  return { scanned: files.length, ok: reasons.length === 0, reasons };
}

function withMeasuredLoad(pack: RolesPack, roleId: string, label: string, loads: readonly RoleLoad[], issues: string[]): RolesPack {
  const measuredLoad: Record<string, { words: number; tokens: number }> = {};
  for (const load of loads.filter(entry => entry.roleId === roleId)) {
    measuredLoad[load.harness] = { words: load.words, tokens: load.tokens };
  }
  try {
    return validateRolesPack({ ...pack, measuredLoad });
  } catch (error) {
    const list = error instanceof RolesPackError ? error.issues : ['the role load could not be validated'];
    issues.push(...list.map(issue => `${label}: ${issue}`));
    return pack;
  }
}

function checkTrims(input: CompileInput, loads: readonly RoleLoad[], skillWords: ReadonlyMap<string, number>,
  budgets: Record<string, { words: number }>): string[] {
  const current = input.currentDefault;
  if (!current) return [];
  const records = new Map<string, TrimRecord[]>();
  for (const record of input.trims ?? []) {
    const subject = typeof record?.subject === 'string' ? record.subject : '';
    records.set(subject, [...(records.get(subject) ?? []), record]);
  }
  const shorter = new Map<string, string>();
  const previousSkills = (role: DefaultLoad['roles'][number]): readonly string[] => role.skillIds
    ?? current.skills.filter(skill => !skill.skillId.includes('/') || skill.skillId.startsWith(`${role.roleId}/`))
      .map(skill => skill.skillId);
  for (const load of loads) {
    const before = current.roles.find(entry => entry.roleId === load.roleId && entry.harness === load.harness);
    const remaining = new Map<string, number>();
    for (const id of load.skillIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);
    const removed = before && previousSkills(before).some(id => {
      const count = remaining.get(id) ?? 0;
      if (count > 0) { remaining.set(id, count - 1); return false; }
      return current.skills.find(skill => skill.skillId === id)?.words !== 0;
    });
    if (before && (load.roleWords < before.words || removed)) {
      shorter.set(`role:${load.roleId}/${load.harness}`, `currentDefault.roles[${current.roles.indexOf(before)}]`);
    }
  }
  for (const [id, words] of skillWords) {
    const before = current.skills.find(entry => entry.skillId === id);
    if (before && words < before.words) shorter.set(`skill:${id}`, `currentDefault.skills[${current.skills.indexOf(before)}]`);
  }
  for (const [index, before] of current.skills.entries()) {
    // Older measurements have no per-role composition; a missing core still needs evidence.
    if (before.words > 0 && !skillWords.has(before.skillId)
      && !current.roles.some(role => previousSkills(role).includes(before.skillId))) {
      shorter.set(`skill:${before.skillId}`, `currentDefault.skills[${index}]`);
    }
  }
  for (const [index, [roleId, budget]] of Object.entries(budgets).entries()) {
    const before = current.budgets.find(entry => entry.roleId === roleId);
    if (before && budget.words < before.words) shorter.set(`budget:${roleId}`, `budgets.json entry ${index}`);
  }
  const issues: string[] = [];
  for (const [subject, label] of shorter) {
    const found = records.get(subject) ?? [];
    if (found.length === 0) {
      issues.push(`${label} is shorter than the current default and has no trim record`);
      continue;
    }
    if (found.length > 1) issues.push(`${label} has ${found.length} trim records where one is expected`);
    issues.push(...trimRecordIssues(label, found[0]!));
  }
  return issues;
}

/**
 * Build every role in a source folder. Throws PackCompileError listing everything wrong with
 * the build: a missing source, a pin that does not match the file, a skill over its budget, a
 * role over its recorded budget, or a compiled file the scanner would not take.
 */
export function compilePacks(input: CompileInput): PackBuild {
  const issues: string[] = [];
  const warnings: string[] = [];
  const sourceDir = input.sourceDir;
  if (typeof input.packVersion === 'string' && hasSecret(input.packVersion)) {
    issues.push('pack version must use a ${NAME} reference instead of a secret literal');
  } else if (!isSemanticVersion(input.packVersion)) issues.push('pack version must be a semantic version');
  const harnesses = [...(input.harnesses ?? PACK_HARNESSES)];
  for (const [index, harness] of harnesses.entries()) {
    if (!(PACK_HARNESSES as readonly string[]).includes(harness)) issues.push(`harnesses[${index}] is not a harness a pack compiles for`);
  }
  if (harnesses.length === 0) issues.push('the build requires at least one harness');
  if (new Set(harnesses).size !== harnesses.length) issues.push('the build must not repeat a harness');
  const targetWords = input.targetWords ?? PACK_BUDGETS.roleTargetWords;
  if (!Number.isSafeInteger(targetWords) || targetWords < 1) issues.push('the role target must be a positive integer');
  if (issues.length > 0) throw new PackCompileError(issues);

  const shared = new Map<PackHarness, string>();
  const dispatch = new Map<PackHarness, string>();
  for (const harness of harnesses) {
    const rules = readSource(join(sourceDir, 'shared', 'rules', `${harness}.md`), sourceDir);
    if (!rules) issues.push(`the shared rules for ${harness} are missing`);
    else shared.set(harness, rules.content);
    const protocol = readSource(join(sourceDir, 'shared', 'dispatch', `${harness}.md`), sourceDir);
    if (!protocol) issues.push(`the dispatch protocol for ${harness} is missing`);
    else dispatch.set(harness, protocol.content);
  }

  const budgets = readBudgets(sourceDir, issues);
  const rolesDir = join(sourceDir, 'roles');
  const skills: Map<string, SkillRecord> = new Map();
  const loads: RoleLoad[] = [];
  const files: CompiledFile[] = [];
  const packs: Record<string, RolesPack> = {};

  for (const { id: roleId, label } of roleIds(sourceDir, input.roles, issues)) {
    const roleDir = resolveInside(join(rolesDir, roleId), sourceDir);
    if (!roleDir) {
      issues.push(`${label} folder must remain inside the source folder`);
      continue;
    }
    const pack = readPack(join(roleDir, 'role.json'), sourceDir, label, issues);
    if (!pack) continue;
    if (pack.identity.id !== roleId) issues.push(`${label} folder does not match the pack identity.id`);
    const skillIds = [
      ...pack.skills.shared.map(skill => skill.id),
      ...pack.skills.private.map(skill => `${roleId}/${skill.path}`),
    ];
    const sections: Array<{ name: string; text: string }> = [];
    for (const [index, skill] of pack.skills.shared.entries()) {
      const skillLabel = `${label} skills.shared[${index}]`;
      const source = readSource(join(sourceDir, 'skills', skill.id, 'SKILL.md'), sourceDir);
      if (!source) {
        issues.push(`${skillLabel} has no SKILL.md`);
        continue;
      }
      const version = sourceSkillVersion(source.content, `${skillLabel} SKILL.md`);
      if (!version) issues.push(`${skillLabel} SKILL.md names no semantic version in its front matter`);
      else if (version !== skill.version) {
        issues.push(`${skillLabel} version does not match the pack pin`);
      }
      if (source.sha256 !== skill.sha256.toLowerCase()) {
        issues.push(`${skillLabel} sha256 does not match the pack pin`);
      }
      recordSkill(skills, skill.id, skillLabel, version ?? skill.version, source, issues, warnings);
      sections.push({ name: `skill ${skill.id}`, text: skillCoreText(source.content) });
    }
    for (const [index, bundled] of pack.skills.private.entries()) {
      const skillLabel = `${label} skills.private[${index}]`;
      const source = readSource(join(roleDir, bundled.path), roleDir);
      if (!source) {
        issues.push(`${skillLabel} is missing`);
        continue;
      }
      if (source.sha256 !== bundled.sha256.toLowerCase()) {
        issues.push(`${skillLabel} sha256 does not match the pack pin`);
      }
      const version = sourceSkillVersion(source.content, skillLabel);
      if (!version) issues.push(`${skillLabel} names no semantic version in its front matter`);
      recordSkill(skills, `${roleId}/${bundled.path}`, skillLabel, version ?? pack.identity.version, source, issues, warnings);
      sections.push({ name: `skill ${bundled.path}`, text: skillCoreText(source.content) });
    }
    for (const harness of harnesses) {
      const compiled = compileRole(harness, pack, {
        shared: shared.get(harness) ?? '', dispatch: dispatch.get(harness) ?? '', skills: sections,
      });
      const words = countWords(compiled.content);
      const budgetWords = budgets[roleId]?.words ?? null;
      const roleWords = compiled.parts.find(part => part.name === 'role section')!.words;
      loads.push({ roleId, harness, words, tokens: estimateTokens(words), roleWords, skillIds: [...skillIds], parts: compiled.parts, targetWords, budgetWords });
      if (budgetWords !== null && words > budgetWords) {
        issues.push(`${label} measuredLoad.${harness}.words exceeds the recorded budgets.words`);
      } else if (words > targetWords) {
        warnings.push(`role "${roleId}" on ${harness} measures ${words} words, above the ${targetWords}-word target`);
      }
      files.push({ path: `roles/${roleId}/${harness}.md`, content: compiled.content, sha256: sha256Of(compiled.content), roleId, harness });
    }
    packs[roleId] = withMeasuredLoad(pack, roleId, label, loads, issues);
  }

  if (issues.length > 0) throw new PackCompileError(issues);
  const scannerResult = runScanner(files, input.scan);
  if (!scannerResult.ok) issues.push(...scannerResult.reasons);
  const trimIssues = checkTrims(input, loads, new Map([...skills].map(record => [record[0], record[1].words])), budgets);
  issues.push(...trimIssues.filter(issue => issue.startsWith('budgets.json entry ')));
  if (issues.length > 0) throw new PackCompileError(issues);

  const pins = [...skills.values()].map(({ id, version, sha256 }: SkillRecord) => ({ id, version, sha256 }));
  return {
    packVersion: input.packVersion,
    roles: packs,
    files,
    loads,
    skills: pins,
    warnings,
    defaultEligible: trimIssues.length === 0,
    trimIssues,
    receipt: {
      packVersion: input.packVersion,
      scannerResult,
      files: files.map(file => ({ path: file.path, sha256: file.sha256 })),
      skills: pins,
      approvedBy: null,
    },
  };
}
