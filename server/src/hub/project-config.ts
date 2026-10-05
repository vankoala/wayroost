import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const PROJECT_CONFIG_PROVIDERS = ['claude', 'codex', 'opencode', 'pi', 'copilot', 'gemini', 'hermes'] as const;
export type ProjectConfigProvider = typeof PROJECT_CONFIG_PROVIDERS[number];
export type ProjectConfigOwner = ProjectConfigProvider | 'cursor' | 'paseo' | 'vscode' | 'direnv';
export type ProjectConfigKind = 'grants-permissions' | 'runs-hooks' | 'runs-code' | 'instructions' | 'unknown';
export type ProjectConfigDecision = 'allow' | 'neutralise' | 'refuse';

export const MAX_PROJECT_CONFIG_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 1024;
const MAX_SCAN_DEPTH = 32;

export interface ProjectConfigFinding {
  /** Relative to the workspace root. */
  path: string;
  kind: ProjectConfigKind;
  providers: ProjectConfigOwner[];
  reason: string;
}

export interface ProjectConfigScan {
  findings: ProjectConfigFinding[];
  errors: Array<{ path: string; reason: string }>;
}

export interface ProjectConfigSummary extends ProjectConfigFinding {
  decision: ProjectConfigDecision;
}

export type ProjectConfigLaunchOptions =
  | { settingSources: ['user'] }
  | { env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } };

export interface ProjectConfigCapabilities {
  /** Set only after the runtime is verified to disable project settings, plugins, tools, agents, commands, and skills. */
  opencodeProjectConfigDisable?: boolean;
}

export interface ProjectConfigCheck {
  provider: ProjectConfigProvider;
  decision: ProjectConfigDecision;
  launchOptions?: ProjectConfigLaunchOptions;
  reasons: string[];
  summary: ProjectConfigSummary[];
}

const KIND_REASON: Record<ProjectConfigKind, string> = {
  'grants-permissions': 'Can grant tool permissions or skip approval.',
  'runs-hooks': 'Can run hooks before or after tool use.',
  'runs-code': 'Can load plugins or start a local command.',
  instructions: 'Instruction text only.',
  unknown: 'Cannot establish what this configuration enables.',
};
const WORKSPACE_CONFIG_LOADERS: Partial<Record<ProjectConfigOwner, string>> = {
  paseo: 'Paseo', vscode: 'VS Code', direnv: 'direnv',
};

const normalKey = (key: string) => key.toLowerCase().replace(/[-_\s]/g, '');
const populated = (value: unknown) => value !== false && value !== null && value !== '' &&
  (!Array.isArray(value) || value.length > 0) &&
  (typeof value !== 'object' || value === null || Object.keys(value).length > 0);
const unsafeMode = (value: unknown) => typeof value === 'string' &&
  /bypass|acceptedits|allow|never|dontask|fullaccess|danger|yolo|unrestricted|skippermission/i.test(normalKey(value));

function jsoncText(text: string): string | undefined {
  const parts: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!quoted && char === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i++;
      parts.push(' ');
      continue;
    }
    if (!quoted && char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      parts.push(' ');
      continue;
    }
    parts.push(char);
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  const uncommented = parts.join('');
  parts.length = 0;
  quoted = false;
  escaped = false;
  for (let i = 0; i < uncommented.length; i++) {
    const char = uncommented[i]!;
    if (!quoted && char === ',') {
      let next = i + 1;
      while (next < uncommented.length && /\s/.test(uncommented[next]!)) next++;
      if (uncommented[next] === '}' || uncommented[next] === ']') continue;
    }
    parts.push(char);
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return parts.join('');
}

function jsonKinds(text: string, comments = false, mcp = false, workspace?: 'paseo' | 'tasks'): ProjectConfigKind[] {
  let value: unknown;
  const input = comments ? jsoncText(text) : text;
  if (input === undefined) return ['unknown'];
  try { value = JSON.parse(input); }
  catch { return ['unknown']; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['unknown'];
  const kinds = new Set<ProjectConfigKind>();
  const pending = [{ value, depth: 0, permissions: false, mcp }];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++entries > 16_384 || current.depth > 64) { kinds.add('unknown'); break; }
    if (current.value === null || typeof current.value !== 'object') continue;
    for (const [key, child] of Object.entries(current.value)) {
      const name = normalKey(key);
      const permissions = current.permissions || /permission|approval/.test(name);
      const mcp = current.mcp || name === 'mcp' || name === 'mcpservers';
      if (name === 'hooks' || name.endsWith('hooks')) kinds.add('runs-hooks');
      if (/^(allow|allowed|allowlist|allowedtools|autoapprove)$/.test(name) && populated(child)) {
        kinds.add('grants-permissions');
      }
      if ((/skip.*permission|bypass.*permission|disable.*approval/.test(name) && populated(child)) ||
          (/mode|policy/.test(name) && unsafeMode(child)) ||
          (permissions && typeof child === 'string' && normalKey(child) === 'allow')) kinds.add('grants-permissions');
      if ((mcp && name === 'command' && populated(child)) ||
          (/^(plugin|plugins|enabledplugins|extensions|packages)$/.test(name) && populated(child))) kinds.add('runs-code');
      if ((workspace === 'paseo' && /^(setup|worktreesetup|scripts|portscript|command)$/.test(name) && populated(child)) ||
          (workspace === 'tasks' && ((name === 'command' && populated(child)) ||
            (name === 'runon' && child === 'folderOpen')))) kinds.add('runs-code');
      if (child !== null && typeof child === 'object') {
        pending.push({ value: child, depth: current.depth + 1, permissions, mcp });
      }
    }
  }
  return kinds.size ? [...kinds] : ['unknown'];
}

/** A line scan identifies behaviours but cannot establish that TOML is fully understood. */
function tomlKinds(text: string): ProjectConfigKind[] {
  const kinds = new Set<ProjectConfigKind>(['unknown']);
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    let quote = '';
    let escaped = false;
    let line = '';
    for (const char of raw) {
      if (char === '#' && !quote) break;
      line += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote === '"') { escaped = true; continue; }
      if (char === quote) quote = '';
      else if (!quote && (char === '"' || char === "'")) quote = char;
    }
    line = line.trim();
    if (!line) continue;
    const table = /^(?:\[([\w.\-"' ]+)\]|\[\[([\w.\-"' ]+)\]\])$/.exec(line);
    if (table) {
      section = normalKey((table[1] ?? table[2])!.replace(/["']/g, ''));
      if (section.includes('hooks')) kinds.add('runs-hooks');
      if (/permission|approval/.test(section)) kinds.add('grants-permissions');
      continue;
    }
    const assignment = /^([\w.-]+|"[\w.-]+"|'[\w.-]+')\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = normalKey(assignment[1]!.replace(/["']/g, ''));
    const value = assignment[2]!;
    if (key.includes('hooks')) kinds.add('runs-hooks');
    if ((/permission|approval|mode|policy/.test(key) && unsafeMode(value)) ||
        (/skip.*permission|bypass.*permission/.test(key) && value !== 'false') ||
        (/allow|permission/.test(key) && value !== '[]')) kinds.add('grants-permissions');
    if ((section.includes('mcp') && key === 'command') || /plugin|extensions/.test(key)) kinds.add('runs-code');
  }
  return [...kinds];
}

/** A line scan identifies frontmatter behaviours but cannot validate YAML. */
function markdownKinds(text: string): ProjectConfigKind[] {
  const kinds = new Set<ProjectConfigKind>();
  if (/!\s*`/.test(text)) kinds.add('runs-code');
  const lines = text.replace(/^\uFEFF/, '').trimStart().split(/\r\n?|\n/);
  if (!lines[0]?.startsWith('---')) return kinds.size ? [...kinds] : ['instructions'];
  kinds.add('unknown');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  const header = lines.slice(1, end === -1 ? undefined : end);
  let permissions = false;
  let mcp = false;
  let command = false;
  for (const line of header) {
    for (const field of line.matchAll(/(?:^|[{,])\s*["']?([\w.-]+)["']?\s*:\s*/g)) {
      const key = normalKey(field[1]!);
      const value = line.slice(field.index! + field[0].length).trim();
      if (key === 'hooks' || key.endsWith('hooks')) kinds.add('runs-hooks');
      permissions ||= /permission|approval/.test(key);
      mcp ||= key === 'mcp' || key === 'mcpservers';
      command ||= key === 'command';
      if ((/^(allow|allowed|allowlist|allowedtools|autoapprove)$/.test(key) &&
          !/^(?:false|null|\[\]|\{\}|""|'')(?:\s*(?:#.*)?)$/.test(value)) ||
          (/skip.*permission|bypass.*permission|disable.*approval/.test(key) && value !== 'false') ||
          (/mode|policy/.test(key) && unsafeMode(value))) kinds.add('grants-permissions');
      if (/^(plugin|plugins|enabledplugins|extensions|packages)$/.test(key)) kinds.add('runs-code');
    }
  }
  if (permissions && unsafeMode(header.join('\n'))) kinds.add('grants-permissions');
  if (mcp && command) kinds.add('runs-code');
  return [...kinds];
}

class ScanError extends Error {
  constructor(readonly path: string, message: string) { super(message); }
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

export function scanProjectConfig(folder: string, workspaceRoot: string): ProjectConfigScan {
  const root = resolve(workspaceRoot);
  const cwd = resolve(folder);
  const findings: ProjectConfigFinding[] = [];
  const errors: ProjectConfigScan['errors'] = [];
  const withinRoot = (path: string) => {
    const child = relative(root, path);
    return !/^\.\.(?:[/\\]|$)/.test(child) && !isAbsolute(child);
  };
  const label = (path: string) => relative(root, path).replaceAll('\\', '/') || '.';
  const add = (path: string, kind: ProjectConfigKind, providers: readonly ProjectConfigOwner[], reason = KIND_REASON[kind]) => {
    findings.push({ path: label(path), kind, providers: [...providers], reason });
  };
  let entries = 0;
  let bytes = 0;
  const snapshots = new Map<string, Stats | undefined>();
  const listings = new Map<string, string[]>();
  const inspect = (path: string): Stats | undefined => {
    if (++entries > MAX_SCAN_ENTRIES) throw new ScanError(path, 'The configuration scan exceeded its entry limit.');
    let info: Stats | undefined;
    try { info = lstatSync(path); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ScanError(path, 'The configuration path could not be inspected.');
    }
    if (!snapshots.has(path)) snapshots.set(path, info);
    return info;
  };
  const verifyParents = (path: string) => {
    const parents: string[] = [];
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      parents.push(parent);
      if (parent === dirname(parent)) break;
    }
    for (const parent of parents.reverse()) {
      const info = inspect(parent);
      if (!info?.isDirectory() || info.isSymbolicLink()) throw new ScanError(parent, 'A parent is missing, linked, or not a directory.');
    }
  };
  const directory = (path: string, providers: readonly ProjectConfigOwner[], visit: () => void) => {
    const info = inspect(path);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      add(path, 'unknown', providers, 'The configuration directory is linked or is not a directory; it was not followed.');
      return;
    }
    verifyParents(path);
    try { visit(); }
    catch (err) {
      if (err instanceof ScanError) throw err;
      throw new ScanError(path, 'The configuration directory could not be scanned.');
    }
    const after = inspect(path);
    if (!after?.isDirectory() || !sameFile(info, after)) throw new ScanError(path, 'The configuration directory changed during the scan.');
  };
  const eachChild = (path: string, visit: (child: string) => void) => {
    verifyParents(join(path, 'entry'));
    const names: string[] = [];
    try {
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++entries > MAX_SCAN_ENTRIES) throw new ScanError(path, 'The configuration scan exceeded its entry limit.');
          names.push(entry.name);
          visit(join(path, entry.name));
        }
      } finally { dir.closeSync(); }
    } catch (err) {
      if (err instanceof ScanError) throw err;
      throw new ScanError(path, 'The configuration directory could not be scanned.');
    }
    names.sort();
    const before = listings.get(path);
    if (before && (before.length !== names.length || before.some((name, index) => name !== names[index]))) {
      throw new ScanError(path, 'The configuration directory entries changed during the scan.');
    }
    if (!before) listings.set(path, names);
  };
  const config = (path: string, providers: readonly ProjectConfigOwner[],
    format: 'json' | 'jsonc' | 'toml' | 'markdown' | 'paseo' | 'tasks' | 'shell', forced?: ProjectConfigKind) => {
    const info = inspect(path);
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink()) {
      add(path, 'unknown', providers, 'The configuration file is linked or is not a regular file; it was not read.');
      return;
    }
    if (info.size > MAX_PROJECT_CONFIG_BYTES) throw new ScanError(path, 'The configuration file exceeds the size limit.');
    verifyParents(path);
    let fd: number | undefined;
    let text: string;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!opened.isFile() || !sameFile(info, opened)) throw new ScanError(path, 'The configuration file changed before it could be read.');
      const buffer = Buffer.alloc(MAX_PROJECT_CONFIG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
        bytes += count;
        if (length > MAX_PROJECT_CONFIG_BYTES || bytes > MAX_SCAN_BYTES) throw new ScanError(path, 'The configuration scan exceeded its size limit.');
      }
      verifyParents(path);
      const after = inspect(path);
      if (!after || !sameFile(info, after) || !sameFile(info, fstatSync(fd))) throw new ScanError(path, 'The configuration file changed during the scan.');
      text = buffer.subarray(0, length).toString('utf8');
    } catch (err) {
      if (err instanceof ScanError) throw err;
      throw new ScanError(path, 'The configuration file could not be read.');
    } finally { if (fd !== undefined) closeSync(fd); }
    // direnv sources the file as shell code.
    const kinds = new Set<ProjectConfigKind>(format === 'shell' ? ['runs-code']
      : format === 'markdown' ? markdownKinds(text) : format === 'toml' ? tomlKinds(text)
        : jsonKinds(text, format === 'jsonc' || format === 'tasks', /(?:^|[/\\])\.?mcp\.json$/.test(path),
          format === 'paseo' || format === 'tasks' ? format : undefined));
    if (forced) kinds.add(forced);
    for (const kind of kinds) add(path, kind, providers);
  };
  const tree = (path: string, providers: readonly ProjectConfigOwner[], kind: ProjectConfigKind, depth = 0): void => {
    if (depth > MAX_SCAN_DEPTH) throw new ScanError(path, 'The configuration directory exceeds the depth limit.');
    const info = inspect(path);
    if (!info) return;
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      add(path, 'unknown', providers, 'The configuration path is linked or is not a regular file or directory; it was not followed.');
    } else if (info.isDirectory()) {
      add(path, kind, providers);
      directory(path, providers, () => eachChild(path, child => tree(child, providers, kind, depth + 1)));
    } else if (path.endsWith('.json') && kind === 'runs-hooks') config(path, providers, 'json', kind);
    else add(path, kind, providers);
  };
  const markdownTree = (path: string, providers: readonly ProjectConfigOwner[], skills = false, depth = 0): void => {
    if (depth > MAX_SCAN_DEPTH) throw new ScanError(path, 'The configuration directory exceeds the depth limit.');
    directory(path, providers, () => {
      const handled: Stats[] = [];
      if (skills) {
        // Canonical probes use the filesystem's casing rules.
        const skill = join(path, 'SKILL.md');
        config(skill, providers, 'markdown');
        const info = snapshots.get(skill);
        if (info) handled.push(info);
        if (providers.includes('claude')) {
          // Plugin defaults and referenced components can run code beyond the manifest.
          const plugin = join(path, '.claude-plugin');
          directory(plugin, ['claude'], () => config(join(plugin, 'plugin.json'), ['claude'], 'json', 'unknown'));
          const info = snapshots.get(plugin);
          if (info) handled.push(info);
        }
      }
      eachChild(path, child => {
        const info = inspect(child);
        if (!info || handled.some(before => sameFile(before, info))) return;
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          add(child, 'unknown', providers, 'The configuration path is linked or is not a regular file or directory; it was not followed.');
        } else if (info.isDirectory()) markdownTree(child, providers, skills, depth + 1);
        else if (!skills && child.endsWith('.md')) config(child, providers, 'markdown');
      });
    });
  };
  const scanFolder = (path: string) => {
    directory(join(path, '.claude'), ['claude', 'copilot', 'opencode'], () => {
      for (const name of ['settings.json', 'settings.local.json']) config(join(path, '.claude', name), ['claude', 'copilot'], 'json');
      config(join(path, '.claude/hooks.json'), ['claude', 'copilot'], 'json', 'runs-hooks');
      tree(join(path, '.claude/hooks'), ['claude', 'copilot'], 'runs-hooks');
      markdownTree(join(path, '.claude/agents'), ['claude', 'copilot', 'opencode']);
      markdownTree(join(path, '.claude/skills'), ['claude', 'copilot', 'opencode'], true);
      markdownTree(join(path, '.claude/commands'), ['claude', 'copilot']);
    });
    directory(join(path, '.github'), ['copilot'], () => {
      tree(join(path, '.github/hooks'), ['copilot'], 'runs-hooks');
      markdownTree(join(path, '.github/agents'), ['copilot']);
      markdownTree(join(path, '.github/skills'), ['copilot'], true);
      config(join(path, '.github/mcp.json'), ['copilot'], 'json');
      directory(join(path, '.github/copilot'), ['copilot'], () => {
        for (const name of ['settings.json', 'settings.local.json']) config(join(path, '.github/copilot', name), ['copilot'], 'json');
      });
    });
    directory(join(path, '.agents'), ['copilot', 'opencode'], () => markdownTree(join(path, '.agents/skills'), ['copilot', 'opencode'], true));
    directory(join(path, '.cursor'), ['cursor'], () => eachChild(join(path, '.cursor'), child => {
      if (/^hooks.*\.json$/.test(relative(join(path, '.cursor'), child))) config(child, ['cursor'], 'json', 'runs-hooks');
    }));
    directory(join(path, '.codex'), ['codex'], () => {
      config(join(path, '.codex/config.toml'), ['codex'], 'toml');
      config(join(path, '.codex/hooks.json'), ['codex'], 'json', 'runs-hooks');
    });
    directory(join(path, '.gemini'), ['gemini'], () => config(join(path, '.gemini/settings.json'), ['gemini'], 'json'));
    directory(join(path, '.opencode'), ['opencode'], () => {
      config(join(path, '.opencode/opencode.json'), ['opencode'], 'json');
      config(join(path, '.opencode/opencode.jsonc'), ['opencode'], 'jsonc');
      for (const name of ['plugin', 'plugins', 'tool', 'tools']) tree(join(path, '.opencode', name), ['opencode'], 'runs-code');
      for (const name of ['agent', 'agents', 'mode', 'modes', 'command', 'commands']) markdownTree(join(path, '.opencode', name), ['opencode']);
      for (const name of ['skill', 'skills']) markdownTree(join(path, '.opencode', name), ['opencode'], true);
    });
    config(join(path, 'opencode.json'), ['opencode'], 'json');
    config(join(path, 'opencode.jsonc'), ['opencode'], 'jsonc');
    directory(join(path, '.pi'), ['pi'], () => {
      config(join(path, '.pi/settings.json'), ['pi'], 'json');
      tree(join(path, '.pi'), ['pi'], 'runs-code');
    });
    config(join(path, '.mcp.json'), ['claude', 'copilot'], 'json');
    config(join(path, 'paseo.json'), ['paseo'], 'paseo');
    directory(join(path, '.vscode'), ['vscode'], () => config(join(path, '.vscode/tasks.json'), ['vscode'], 'tasks'));
    config(join(path, '.envrc'), ['direnv'], 'shell');
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      if (inspect(join(path, name))) add(join(path, name), 'instructions', PROJECT_CONFIG_PROVIDERS);
    }
  };
  try {
    if (!withinRoot(cwd)) throw new ScanError(cwd, 'The worker folder is outside the workspace root.');
    verifyParents(join(cwd, 'entry'));
    let depth = 0;
    for (let path = cwd; ;) {
      if (++depth > MAX_SCAN_DEPTH) throw new ScanError(path, 'The worker folder exceeds the parent scan limit.');
      scanFolder(path);
      if (relative(root, path) === '') break;
      const parent = dirname(path);
      if (parent === path) throw new ScanError(path, 'The workspace root could not be reached.');
      path = parent;
    }
    const revalidate = (path: string, before: Stats | undefined) => {
      const after = inspect(path);
      const unchanged = before && after && (before.isDirectory() && !withinRoot(path)
        ? before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
        : sameFile(before, after));
      if (before ? !unchanged : after !== undefined) {
        throw new ScanError(path, 'The configuration path changed during the scan.');
      }
    };
    for (const [path, before] of snapshots) revalidate(path, before);
    for (const path of listings.keys()) eachChild(path, () => {});
    // Recheck directories after their contents so late additions also fail closed.
    for (const [path, before] of [...snapshots].reverse()) {
      if (before?.isDirectory()) revalidate(path, before);
    }
  } catch (err) {
    const path = err instanceof ScanError ? label(err.path) : '.';
    errors.push({ path, reason: err instanceof ScanError ? err.message : 'The configuration scan could not be completed.' });
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { findings, errors };
}

export function decideProjectConfig(scan: ProjectConfigScan, provider: ProjectConfigProvider,
  capabilities: ProjectConfigCapabilities = {}): ProjectConfigCheck {
  const launchOptions: ProjectConfigLaunchOptions | undefined = provider === 'claude'
    ? { settingSources: ['user'] }
    : provider === 'opencode' && capabilities.opencodeProjectConfigDisable === true
      ? { env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } } : undefined;
  const summary: ProjectConfigSummary[] = scan.findings.map(finding => {
    const loader = finding.providers.map(owner => WORKSPACE_CONFIG_LOADERS[owner]).find(name => name !== undefined);
    const loaded = loader !== undefined || finding.providers.includes(provider);
    const decision = finding.kind === 'instructions' || !loaded ? 'allow' : launchOptions && !loader ? 'neutralise' : 'refuse';
    const reason = finding.kind === 'instructions' ? KIND_REASON.instructions : !loaded
      ? `${provider} does not load this configuration.`
      : `${finding.reason} ${loader ? `${loader} loads this configuration independently of provider launch options.` :
        decision === 'neutralise' ? 'Project configuration will be disabled.' :
        provider === 'opencode' ? 'The runtime has not been verified to disable project configuration.' :
          'Project configuration cannot be disabled for this provider.'}`;
    return { ...finding, providers: [...finding.providers], decision, reason };
  });
  for (const error of scan.errors) summary.push({ ...error, kind: 'unknown', providers: [...PROJECT_CONFIG_PROVIDERS], decision: 'refuse' });
  const decision = scan.errors.length || summary.some(row => row.decision === 'refuse') ? 'refuse'
    : summary.some(row => row.decision === 'neutralise') ? 'neutralise' : 'allow';
  const reasons = summary.filter(row => row.decision !== 'allow').map(row => `${row.path}: ${row.reason}`);
  return { provider, decision, ...(decision === 'neutralise' ? { launchOptions } : {}), reasons, summary };
}

export function checkProjectConfig(folder: string, workspaceRoot: string, provider: ProjectConfigProvider,
  capabilities: ProjectConfigCapabilities = {}): ProjectConfigCheck {
  return decideProjectConfig(scanProjectConfig(folder, workspaceRoot), provider, capabilities);
}
