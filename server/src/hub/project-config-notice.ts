import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectConfigNotice, ProjectConfigReport } from '../../../shared/protocol.js';
import {
  PROJECT_CONFIG_PROVIDERS,
  scanProjectConfig,
  type ProjectConfigFinding,
  type ProjectConfigKind,
  type ProjectConfigOwner,
  type ProjectConfigScan,
} from './project-config.js';

// The words a person reads before an agent starts working in a folder: what that folder's own files
// let the agent do. Wayroost reads the folder as its owner, and reports
// names and kinds only — a folder's configuration is never quoted back.

/** The check itself. Tests and the visual check give their own, so folders can be planted at run time. */
export type ProjectConfigScanner = (folder: string) => ProjectConfigScan;

/** Read through the containing workspace, including configuration inherited by a nested folder. */
export function scanFolderProjectConfig(folder: string, workspaceRoots: readonly string[] = []): ProjectConfigScan {
  const cwd = resolve(folder);
  const workspace = workspaceRoots.filter(isAbsolute).map((root) => resolve(root))
    .filter((root) => {
      const child = relative(root, cwd);
      return !isAbsolute(child) && !/^\.\.(?:[/\\]|$)/.test(child);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (workspace) return scanProjectConfig(cwd, workspace);
  let fallback: string | undefined;
  for (let root = cwd; ; root = dirname(root)) {
    for (const marker of ['.git', 'paseo.json']) {
      try {
        const info = lstatSync(join(root, marker));
        if (info.isDirectory() || info.isFile() || (marker === '.git' && info.isSymbolicLink())) {
          if (marker === '.git') return scanProjectConfig(cwd, root);
          fallback ??= root;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (dirname(root) === root) break;
  }
  return scanProjectConfig(cwd, fallback ?? cwd);
}

/** How each tool that reads a folder's own configuration is named to a person. */
const TOOL_NAMES: Record<ProjectConfigOwner, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini',
  hermes: 'Hermes',
  cursor: 'Cursor',
  paseo: 'Paseo',
  vscode: 'VS Code',
  direnv: 'direnv',
};

/** Tools that read a folder's configuration whatever agent is asked to work there. */
const ALWAYS_LOADERS: readonly ProjectConfigOwner[] = ['paseo', 'vscode', 'direnv'];

/** What a folder can hand an agent, as this file puts it into words. */
type NoticedKind = Exclude<ProjectConfigKind, 'instructions'>;

/** Worth saying out loud. A folder's instructions alone (AGENTS.md) are ordinary and go unmentioned. */
const NOTICED: readonly NoticedKind[] = ['grants-permissions', 'runs-hooks', 'runs-code', 'unknown'];

const SENTENCE: Record<NoticedKind, (tools: string) => string> = {
  'grants-permissions': (tools) => `Files here can give ${tools} permission to act without asking.`,
  'runs-hooks': (tools) => `This folder has hooks ${tools} runs without asking.`,
  'runs-code': (tools) => `This folder has code ${tools} runs on its own.`,
  unknown: (tools) => `This folder has ${tools} configuration Wayroost could not read.`,
};

const MAX_FILES = 4;

function listTools(tools: readonly string[]): string {
  const names = tools.map((tool) => TOOL_NAMES[tool as ProjectConfigOwner] ?? tool);
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function listFiles(files: string[]): string[] {
  return files.length > MAX_FILES ? [...files.slice(0, MAX_FILES), `+${files.length - MAX_FILES} more`] : files;
}

/**
 * What to say about a folder before an agent starts there, for the agent that is about to start.
 * A file counts when the chosen agent reads it, or when a tool reads it whatever is chosen.
 */
export function projectConfigNotices(findings: readonly ProjectConfigFinding[], provider: string): ProjectConfigNotice[] {
  const known = (PROJECT_CONFIG_PROVIDERS as readonly string[]).includes(provider);
  const groups = new Map<string, { kind: NoticedKind; tools: string[]; files: string[] }>();
  for (const finding of findings) {
    if (!(NOTICED as readonly ProjectConfigKind[]).includes(finding.kind)) continue;
    // An agent Wayroost doesn't know the habits of: say what any tool would read, rather than nothing.
    const readers = known
      ? finding.providers.filter((owner) => ALWAYS_LOADERS.includes(owner) || owner === provider)
      : finding.providers;
    if (!readers.length) continue;
    const key = `${finding.kind}|${[...readers].sort().join(',')}`;
    const group = groups.get(key) ?? { kind: finding.kind as NoticedKind, tools: [...readers].sort(), files: [] };
    if (!group.files.includes(finding.path)) group.files.push(finding.path);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.tools.join(',').localeCompare(b.tools.join(',')))
    .map((group) => ({ text: SENTENCE[group.kind](listTools(group.tools)), files: listFiles(group.files) }));
}

/** Read a folder and say what it means for the agent about to work in it. */
export function checkProjectConfigNotices(
  folder: string,
  provider: string,
  scan: ProjectConfigScanner = scanFolderProjectConfig,
): ProjectConfigReport {
  let result: ProjectConfigScan;
  try {
    result = scan(folder);
  } catch {
    // The scan refuses rather than guessing. Here that is still only advice, so say it could not be read.
    return { notices: [], unreadable: true };
  }
  const notices = projectConfigNotices(result.findings, provider);
  return result.errors.length ? { notices, unreadable: true } : { notices };
}
