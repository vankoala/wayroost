import * as fs from 'node:fs';
import * as paths from 'node:path';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkProjectConfig, decideProjectConfig, MAX_PROJECT_CONFIG_BYTES, PROJECT_CONFIG_PROVIDERS,
  scanProjectConfig, type ProjectConfigKind, type ProjectConfigProvider,
} from '../src/hub/project-config.js';

vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof fs>('node:fs') }));
vi.mock('node:path', async () => ({ ...await vi.importActual<typeof paths>('node:path') }));

const dirs: string[] = [];
function workspace() {
  const path = fs.mkdtempSync(join(process.cwd(), 'project-config-test-'));
  dirs.push(path);
  return path;
}
function file(root: string, path: string, content: string) {
  const target = join(root, path);
  fs.mkdirSync(join(target, '..'), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function caseInsensitiveFilesystem(root: string) {
  const inspect = fs.lstatSync;
  const open = fs.openSync;
  const directory = fs.opendirSync;
  const resolvePath = (path: fs.PathLike): fs.PathLike => {
    if (typeof path !== 'string') return path;
    const child = relative(root, path);
    if (child.startsWith('..') || paths.isAbsolute(child)) return path;
    let current = root;
    for (const name of child.split(paths.sep).filter(Boolean)) {
      let actual: string | undefined;
      try { actual = fs.readdirSync(current).find(entry => entry.toLowerCase() === name.toLowerCase()); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      current = join(current, actual ?? name);
    }
    return current;
  };
  vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => inspect(resolvePath(path), options as never));
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => open(resolvePath(path), flags, mode));
  vi.spyOn(fs, 'opendirSync').mockImplementation((path, options) => directory(resolvePath(path), options));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('project configuration', () => {
  it('allows a clean folder for every provider without changing launch settings', () => {
    const root = workspace();
    const cwd = join(root, 'packages/demo');
    fs.mkdirSync(cwd, { recursive: true });
    file(root, 'README.md', 'Demo project.');
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      expect(checkProjectConfig(cwd, root, provider)).toEqual({ provider, decision: 'allow', reasons: [], summary: [] });
    }
  });

  const cases: Array<{ path: string; content: string; kinds: ProjectConfigKind[]; providers: ProjectConfigProvider[] }> = [
    { path: '.claude/settings.json', content: JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './allow.sh' }] }] },
      permissions: { allow: ['Bash(*)'], defaultMode: 'acceptEdits' },
    }), kinds: ['runs-hooks', 'grants-permissions'], providers: ['claude', 'copilot'] },
    { path: '.claude/settings.local.json', content: '{"permissions":{"defaultMode":"bypassPermissions"}}', kinds: ['grants-permissions'], providers: ['claude', 'copilot'] },
    { path: '.claude/hooks/allow.sh', content: '#!/bin/sh\nprintf \'{"permissionDecision":"allow"}\\n\'\n', kinds: ['runs-hooks'], providers: ['claude', 'copilot'] },
    { path: '.claude/hooks.json', content: '{"hooks":{}}', kinds: ['runs-hooks'], providers: ['claude', 'copilot'] },
    { path: '.claude/agents/demo.md', content: '---\npermissionMode: bypassPermissions\n---\nDemo agent.', kinds: ['unknown'], providers: ['claude', 'copilot', 'opencode'] },
    { path: '.github/hooks/pre-tool-use.sh', content: '#!/bin/sh\nprintf \'{"permissionDecision":"allow"}\\n\'\n', kinds: ['runs-hooks'], providers: ['copilot'] },
    { path: '.github/hooks/demo.json', content: '{"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"./pre-tool-use.sh"}]}}', kinds: ['runs-hooks'], providers: ['copilot'] },
    { path: '.github/mcp.json', content: '{"mcpServers":{"demo":{"command":"node"}}}', kinds: ['runs-code'], providers: ['copilot'] },
    { path: '.github/copilot/settings.json', content: '{"hooks":{"PreToolUse":[{"type":"command","command":"./allow.sh"}]}}', kinds: ['runs-hooks'], providers: ['copilot'] },
    { path: '.github/copilot/settings.local.json', content: '{"hooks":{"PreToolUse":[{"type":"command","command":"./allow.sh"}]}}', kinds: ['runs-hooks'], providers: ['copilot'] },
    { path: '.codex/config.toml', content: 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n', kinds: ['grants-permissions'], providers: ['codex'] },
    { path: '.codex/hooks.json', content: '{"hooks":{}}', kinds: ['runs-hooks'], providers: ['codex'] },
    { path: '.gemini/settings.json', content: '{"hooks":{},"tools":{"allowed":["run_shell_command"]}}', kinds: ['runs-hooks', 'grants-permissions'], providers: ['gemini'] },
    { path: '.opencode/opencode.json', content: '{"permission":{"bash":"allow"},"mcp":{"demo":{"type":"local","command":["node","demo.js"]}}}', kinds: ['grants-permissions', 'runs-code'], providers: ['opencode'] },
    ...['opencode.json', 'opencode.jsonc', '.opencode/opencode.jsonc'].map(path => ({
      path, content: '{"permission":{"bash":"allow"},"plugin":["./demo.js"]}',
      kinds: ['grants-permissions', 'runs-code'] as ProjectConfigKind[], providers: ['opencode'] as ProjectConfigProvider[],
    })),
    { path: '.opencode/plugin/demo.ts', content: 'export default () => ({});', kinds: ['runs-code'], providers: ['opencode'] },
    { path: '.opencode/plugins/demo.js', content: 'export default () => ({});', kinds: ['runs-code'], providers: ['opencode'] },
    ...['tool/demo.js', 'tools/demo.ts'].map(path => ({
      path: `.opencode/${path}`, content: 'throw new Error("Tool must not run during a scan");',
      kinds: ['runs-code'] as ProjectConfigKind[], providers: ['opencode'] as ProjectConfigProvider[],
    })),
    { path: '.pi/extensions/demo.ts', content: 'export default () => {};', kinds: ['runs-code'], providers: ['pi'] },
    { path: '.pi/settings.json', content: '{"extensions":["./demo.ts"],"skipPermissionChecks":true}', kinds: ['runs-code', 'grants-permissions'], providers: ['pi'] },
    { path: '.mcp.json', content: '{"mcpServers":{"demo":{"command":"node","args":["demo.js"]}}}', kinds: ['runs-code'], providers: ['claude', 'copilot'] },
  ];

  it.each(cases)('lists and contains $path for the providers that load it', ({ path, content, kinds, providers }) => {
    const root = workspace();
    file(root, path, content);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.path === path).map(finding => finding.kind)).toEqual(expect.arrayContaining(kinds));
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      const loaded = providers.includes(provider);
      const decision = !loaded ? 'allow' : provider === 'claude' ? 'neutralise' : 'refuse';
      expect(result.decision).toBe(decision);
      const rows = result.summary.filter(row => row.path === path);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.decision === decision && row.reason.length > 0)).toBe(true);
      if (loaded) expect(result.reasons.some(reason => reason.startsWith(`${path}:`))).toBe(true);
      if (decision === 'neutralise') expect(result.launchOptions).toEqual({ settingSources: ['user'] });
      else expect(result.launchOptions).toBeUndefined();
      if (loaded && provider === 'opencode') {
        const disabled = decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true });
        expect(disabled.decision).toBe('neutralise');
        expect(disabled.launchOptions).toEqual({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } });
      }
    }
  });

  const workspaceCases = [
    { path: 'paseo.json', owner: 'paseo', content: '{"worktree":{"setup":["node demo.js"]}}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"worktree":{"setup":{"command":"node demo.js"}}}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"worktreeSetup":"node demo.js"}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"scripts":{"check":"node demo.js"}}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"scripts":[{"name":"check","command":"node demo.js"}]}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"servicePorts":[{"name":"web","portScript":"node demo.js"}]}' },
    { path: 'paseo.json', owner: 'paseo', content: '{"servicePorts":{"web":{"portScript":"node demo.js"}}}' },
    { path: '.vscode/tasks.json', owner: 'vscode', content: '{"tasks":[{"command":"node demo.js"}]}' },
    { path: '.vscode/tasks.json', owner: 'vscode', content: '{"tasks":[{"type":"npm","script":"check","runOptions":{"runOn":"folderOpen"}}]}' },
    { path: '.vscode/tasks.json', owner: 'vscode', content: '{"tasks":[{"label":"check","windows":{"command":"node demo.js"}}]}' },
    { path: '.vscode/tasks.json', owner: 'vscode', content: '{\n// Workspace task\n"tasks":[{"command":"node demo.js",},],\n}' },
    { path: '.envrc', owner: 'direnv', content: 'export DEMO_MODE=example\nnode demo.js\n' },
  ];
  const workspacePaths = ['paseo.json', '.vscode/tasks.json', '.envrc'];

  it.each(workspaceCases)('contains $owner commands in $path: $content', ({ path, owner, content }) => {
    const root = workspace();
    file(root, path, content);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toEqual([{
      path, kind: 'runs-code', providers: [owner], reason: expect.any(String),
    }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true });
      expect(result.decision).toBe('refuse');
      expect(result.launchOptions).toBeUndefined();
      expect(result.summary).toEqual([{
        path, kind: 'runs-code', providers: [owner], decision: 'refuse',
        reason: expect.stringMatching(/independently of provider launch options/),
      }]);
      expect(result.reasons).toEqual([`${path}: ${result.summary[0]!.reason}`]);
    }
  });

  it.each(workspacePaths)('finds %s only within the workspace ancestry', path => {
    const outer = workspace();
    const root = join(outer, 'repo');
    const cwd = join(root, 'packages/demo');
    const { content, owner } = workspaceCases.find(item => item.path === path)!;
    for (const prefix of ['', 'packages', 'packages/demo']) file(root, join(prefix, path), content);
    file(outer, path, content);
    file(root, join('packages/other', path), content);
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toHaveLength(3);
    for (const prefix of ['', 'packages', 'packages/demo']) expect(scan.findings).toContainEqual({
      path: join(prefix, path).replaceAll('\\', '/'), kind: 'runs-code', providers: [owner], reason: expect.any(String),
    });
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(['paseo.json', '.vscode/tasks.json'].flatMap(path =>
    ['{broken', 'null', '[]', '{"custom":true}', '{/* unfinished'].map(content => ({ path, content })),
  ))('keeps unparseable or unsupported workspace configuration dangerous in $path: $content', ({ path, content }) => {
    const root = workspace();
    file(root, path, content);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toEqual([{
      path, kind: 'unknown', providers: [workspaceCases.find(item => item.path === path)!.owner], reason: expect.any(String),
    }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      expect(decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true }).decision).toBe('refuse');
    }
  });

  it.each([...workspacePaths, '.vscode'])('does not follow linked workspace configuration %s', path => {
    const root = workspace();
    const outside = workspace();
    const target = path === '.vscode' ? outside : file(outside, 'demo', 'node demo.js');
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    fs.symlinkSync(target, join(root, path));
    const open = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(scan.findings).toEqual([{
      path, kind: 'unknown', providers: expect.any(Array), reason: expect.stringMatching(/linked/),
    }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      expect(decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true }).decision).toBe('refuse');
    }
  });

  it.each(workspacePaths)('bounds workspace configuration reads in %s', path => {
    const root = workspace();
    file(root, path, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    const open = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration file exceeds the size limit.' }]);
    expect(open).not.toHaveBeenCalled();
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(workspacePaths)('fails closed when workspace configuration %s cannot be inspected', path => {
    const root = workspace();
    const target = file(root, path, workspaceCases.find(item => item.path === path)!.content);
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((probe, options) => {
      if (probe === target) throw Object.assign(new Error('Cannot inspect demo configuration'), { code: 'EACCES' });
      return original(probe, options as never);
    });
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration path could not be inspected.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(workspacePaths)('fails closed when workspace configuration %s cannot be read', path => {
    const root = workspace();
    const target = file(root, path, workspaceCases.find(item => item.path === path)!.content);
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((probe, flags, mode) => {
      if (probe === target) throw Object.assign(new Error('Cannot read demo configuration'), { code: 'EACCES' });
      return original(probe, flags, mode);
    });
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration file could not be read.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each([...workspacePaths, '.vscode'])('detects late creation of workspace configuration %s', path => {
    const root = workspace();
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    const original = fs.lstatSync;
    const directoryStats = new Map<string, fs.Stats>();
    for (let parent = join(root, path, '..'); ; parent = paths.dirname(parent)) {
      directoryStats.set(parent, original(parent));
      if (parent === root) break;
    }
    let changed = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((probe, options) => {
      if (probe === join(root, 'CLAUDE.md') && !changed) {
        changed = true;
        const configPath = path === '.vscode' ? '.vscode/tasks.json' : path;
        file(root, configPath, workspaceCases.find(item => item.path === configPath)!.content);
      }
      return directoryStats.get(String(probe)) ?? original(probe, options as never);
    });
    const scan = scanProjectConfig(root, root);
    expect(changed).toBe(true);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration path changed during the scan.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(workspacePaths)('does not open workspace configuration %s swapped for a symlink', path => {
    const root = workspace();
    const target = file(root, path, workspaceCases.find(item => item.path === path)!.content);
    const outside = file(workspace(), 'demo', 'node demo.js');
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((probe, flags, mode) => {
      if (probe === target) { fs.unlinkSync(target); fs.symlinkSync(outside, target); }
      return original(probe, flags, mode);
    });
    const read = vi.spyOn(fs, 'readSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration file could not be read.' }]);
    expect(read).not.toHaveBeenCalled();
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(workspacePaths)('refuses workspace configuration %s replaced during reading', path => {
    const root = workspace();
    const target = file(root, path, workspaceCases.find(item => item.path === path)!.content);
    const original = fs.readSync;
    let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation((fd: number, buffer: NodeJS.ArrayBufferView,
      offset?: number | fs.ReadOptions, length?: number, position?: fs.ReadPosition | null) => {
      const count = typeof offset === 'number' ? original(fd, buffer, offset, length!, position ?? null)
        : original(fd, buffer, offset);
      if (!changed) {
        changed = true;
        fs.renameSync(target, `${target}.old`);
        fs.writeFileSync(target, '{}');
      }
      return count;
    });
    const close = vi.spyOn(fs, 'closeSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration file changed during the scan.' }]);
    expect(close).toHaveBeenCalledOnce();
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(workspacePaths)('classifies workspace commands in %s without executing them', path => {
    const root = workspace();
    const marker = join(root, 'workspace-command-ran');
    const command = `touch '${marker}'`;
    const content = path === '.envrc' ? command : JSON.stringify(path === 'paseo.json'
      ? { worktree: { setup: command }, scripts: { check: command }, servicePorts: [{ portScript: command }] }
      : { tasks: [{ command, runOptions: { runOn: 'folderOpen' } }] });
    file(root, path, content);
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toContainEqual({
      path, kind: 'runs-code', providers: [workspaceCases.find(item => item.path === path)!.owner],
      decision: 'refuse', reason: expect.any(String),
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(command);
  });

  const markdownCases: Array<{ path: string; content: string; kind: ProjectConfigKind; providers: ProjectConfigProvider[] }> = [
    ...['.claude/skills', '.github/skills', '.agents/skills'].map(path => ({
      path: `${path}/demo/SKILL.md`, content: '---\nallowed-tools: Bash(*)\n---\nDemo skill.',
      kind: 'grants-permissions' as const,
      providers: (path === '.claude/skills' ? ['claude', 'copilot', 'opencode']
        : path === '.agents/skills' ? ['copilot', 'opencode'] : ['copilot']) as ProjectConfigProvider[],
    })),
    { path: '.claude/commands/team/demo.md', content: '---\nallowed-tools: [Bash(*)]\n---\nDemo command.',
      kind: 'grants-permissions', providers: ['claude', 'copilot'] },
    { path: '.github/agents/demo.agent.md', content: '---\nmcp-servers:\n  demo:\n    command: node\n    args: [demo.js]\n---\nDemo agent.',
      kind: 'runs-code', providers: ['copilot'] },
    ...['agent', 'agents', 'mode', 'modes'].map(name => ({
      path: `.opencode/${name}/build.md`, content: '---\npermission: { bash: allow, edit: allow }\n---\nDemo agent.',
      kind: 'grants-permissions' as const, providers: ['opencode'] as ProjectConfigProvider[],
    })),
    ...['skill', 'skills'].map(name => ({
      path: `.opencode/${name}/demo/SKILL.md`, content: '---\nname: demo\ncustom: true\n---\nDemo skill.',
      kind: 'unknown' as const, providers: ['opencode'] as ProjectConfigProvider[],
    })),
    ...['command', 'commands'].map(name => ({
      path: `.opencode/${name}/demo.md`, content: 'Inspect !`node demo.js`.',
      kind: 'runs-code' as const, providers: ['opencode'] as ProjectConfigProvider[],
    })),
  ];

  it.each(markdownCases)('contains Markdown configuration in $path for each provider that loads it', ({ path, content, kind, providers }) => {
    const root = workspace();
    file(root, path, content);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toContainEqual({ path, kind, providers, reason: expect.any(String) });
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      const decision = !providers.includes(provider) ? 'allow' : provider === 'claude' ? 'neutralise' : 'refuse';
      expect(result.decision).toBe(decision);
      expect(result.summary).toContainEqual({ path, kind, providers, decision, reason: expect.any(String) });
      if (decision === 'neutralise') expect(result.launchOptions).toEqual({ settingSources: ['user'] });
      else expect(result.launchOptions).toBeUndefined();
      if (decision !== 'allow') expect(result.reasons.some(reason => reason.startsWith(`${path}:`))).toBe(true);
    }
    if (providers.includes('opencode')) {
      const result = decideProjectConfig(scan, 'opencode', { opencodeProjectConfigDisable: true });
      expect(result.decision).toBe('neutralise');
      expect(result.launchOptions).toEqual({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } });
    }
  });

  it.each(markdownCases)('finds $path at every level through the workspace root', ({ path, content, kind, providers }) => {
    const outer = workspace();
    const root = join(outer, 'repo');
    const cwd = join(root, 'packages/demo');
    for (const prefix of ['', 'packages', 'packages/demo']) file(root, join(prefix, path), content);
    file(outer, path, content);
    file(root, join('packages/other', path), content);
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.kind === kind).map(finding => finding.path).sort()).toEqual(
      ['', 'packages', 'packages/demo'].map(prefix => join(prefix, path).replaceAll('\\', '/')).sort(),
    );
    for (const provider of providers) {
      expect(decideProjectConfig(scan, provider).decision).toBe(provider === 'claude' ? 'neutralise' : 'refuse');
    }
  });

  it.each(markdownCases.filter(({ path }) => path.endsWith('/SKILL.md')).flatMap(({ path, providers }) =>
    ['SKILL.md', 'skill.md', 'Skill.MD'].map(name => ({ path: join(path, '..', name), canonical: path, providers })),
  ))('contains $path on a case-insensitive filesystem', ({ path, canonical, providers }) => {
    const root = workspace();
    file(root, path, '---\nallowed-tools: Bash(*)\n---\nDemo skill.');
    caseInsensitiveFilesystem(root);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.kind === 'grants-permissions')).toEqual([{
      path: canonical, kind: 'grants-permissions', providers, reason: expect.any(String),
    }]);
    expect(vi.mocked(fs.openSync).mock.calls.filter(([path]) => path === join(root, canonical))).toHaveLength(1);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      const decision = !providers.includes(provider) ? 'allow' : provider === 'claude' ? 'neutralise' : 'refuse';
      expect(result.decision).toBe(decision);
      expect(result.summary).toContainEqual({
        path: canonical, kind: 'grants-permissions', providers, decision, reason: expect.any(String),
      });
      if (decision === 'neutralise') expect(result.launchOptions).toEqual({ settingSources: ['user'] });
      else expect(result.launchOptions).toBeUndefined();
    }
    if (providers.includes('opencode')) {
      expect(decideProjectConfig(scan, 'opencode', { opencodeProjectConfigDisable: true }).launchOptions)
        .toEqual({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } });
    }
  });

  it.each([
    '.claude/skills/demo/skill.md', '.claude/skills/demo/Skill.MD',
    '.claude/skills/demo/.CLAUDE-PLUGIN/plugin.json', '.claude/skills/demo/.claude-plugin/PLUGIN.JSON',
  ])('respects native filesystem casing for %s', path => {
    const root = workspace();
    const plugin = path.endsWith('.json') || path.endsWith('.JSON');
    const canonical = plugin ? '.claude/skills/demo/.claude-plugin/plugin.json' : '.claude/skills/demo/SKILL.md';
    file(root, path, plugin ? '{"hooks":{}}' : '---\nallowed-tools: Bash(*)\n---');
    const loaded = fs.existsSync(join(root, canonical));
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe(loaded ? 'neutralise' : 'allow');
    expect(result.summary.some(row => row.path === canonical)).toBe(loaded);
  });

  it.each([
    { directory: '.claude-plugin', manifest: 'plugin.json' },
    { directory: '.CLAUDE-PLUGIN', manifest: 'plugin.json' },
    { directory: '.ClAuDe-PlUgIn', manifest: 'Plugin.JSON' },
    { directory: '.claude-plugin', manifest: 'PLUGIN.JSON' },
  ].flatMap(casing => [
    { ...casing, content: '{"hooks":{"SessionStart":[{"command":"node demo.js"}]}}', kind: 'runs-hooks' as const },
    { ...casing, content: '{"mcpServers":{"demo":{"command":"node"}}}', kind: 'runs-code' as const },
  ]))('contains embedded $directory/$manifest with $kind on a case-insensitive filesystem', ({ directory, manifest, content, kind }) => {
    const root = workspace();
    const canonical = '.claude/skills/demo/.claude-plugin/plugin.json';
    file(root, '.claude/skills/demo/SKILL.md', 'Demo instructions.');
    file(root, `.claude/skills/demo/${directory}/${manifest}`, content);
    const supporting = file(root, `.claude/skills/demo/${directory}/reference/SKILL.md`, '---\nallowed-tools: Bash(*)\n---');
    caseInsensitiveFilesystem(root);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.path === canonical).map(finding => finding.kind).sort())
      .toEqual([kind, 'unknown'].sort());
    expect(vi.mocked(fs.openSync).mock.calls.some(([path]) => path === supporting)).toBe(false);
    expect(vi.mocked(fs.openSync).mock.calls.filter(([path]) => path === join(root, canonical))).toHaveLength(1);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      expect(result.decision).toBe(provider === 'claude' ? 'neutralise' : 'allow');
      if (provider === 'claude') {
        expect(result.launchOptions).toEqual({ settingSources: ['user'] });
        expect(result.reasons.every(reason => reason.startsWith(`${canonical}:`))).toBe(true);
      } else expect(result.launchOptions).toBeUndefined();
    }
  });

  it.each([
    { path: '.claude/skills/demo/skill.md', canonical: '.claude/skills/demo/SKILL.md' },
    { path: '.claude/skills/demo/.CLAUDE-PLUGIN/PLUGIN.JSON', canonical: '.claude/skills/demo/.claude-plugin/plugin.json' },
  ])('bounds canonical reads of $path on a case-insensitive filesystem', ({ path, canonical }) => {
    const root = workspace();
    file(root, path, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    caseInsensitiveFilesystem(root);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: canonical, reason: 'The configuration file exceeds the size limit.' }]);
    expect(fs.openSync).not.toHaveBeenCalled();
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each([
    { path: '.claude/skills/demo/skill.md', canonical: '.claude/skills/demo/SKILL.md' },
    { path: '.claude/skills/demo/.CLAUDE-PLUGIN/PLUGIN.JSON', canonical: '.claude/skills/demo/.claude-plugin/plugin.json' },
  ])('fails closed when canonical $path cannot be read on a case-insensitive filesystem', ({ path, canonical }) => {
    const root = workspace();
    file(root, path, '{"hooks":{}}');
    caseInsensitiveFilesystem(root);
    const original = vi.mocked(fs.openSync).getMockImplementation()!;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (path === join(root, canonical)) throw Object.assign(new Error('Cannot read demo configuration'), { code: 'EACCES' });
      return original(path, flags, mode);
    });
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: canonical, reason: 'The configuration file could not be read.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each([
    { path: '.claude/skills/demo/skill.md', canonical: '.claude/skills/demo/SKILL.md' },
    { path: '.claude/skills/demo/.CLAUDE-PLUGIN/PLUGIN.JSON', canonical: '.claude/skills/demo/.claude-plugin/plugin.json' },
  ])('detects late creation of canonical $path on a case-insensitive filesystem', ({ path, canonical }) => {
    const root = workspace();
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    const directoryStats = new Map<string, fs.Stats>();
    for (let parent = join(root, path, '..'); ; parent = paths.dirname(parent)) {
      directoryStats.set(parent.toLowerCase(), fs.lstatSync(parent));
      if (parent === root) break;
    }
    caseInsensitiveFilesystem(root);
    const original = vi.mocked(fs.lstatSync).getMockImplementation()!;
    let changed = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((probe, options) => {
      if (probe === join(root, 'CLAUDE.md') && !changed) {
        changed = true;
        file(root, path, '{"hooks":{}}');
      }
      return directoryStats.get(String(probe).toLowerCase()) ?? original(probe, options as never);
    });
    const scan = scanProjectConfig(root, root);
    expect(changed).toBe(true);
    expect(scan.errors).toEqual([{ path: canonical, reason: 'The configuration path changed during the scan.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each([
    { path: '.claude/skills/demo/skill.md', canonical: '.claude/skills/demo/SKILL.md' },
    { path: '.claude/skills/demo/.CLAUDE-PLUGIN', canonical: '.claude/skills/demo/.claude-plugin' },
    { path: '.claude/skills/demo/.CLAUDE-PLUGIN/PLUGIN.JSON', canonical: '.claude/skills/demo/.claude-plugin/plugin.json' },
  ])('does not follow linked $path on a case-insensitive filesystem', ({ path, canonical }) => {
    const root = workspace();
    const outside = workspace();
    const target = path.endsWith('.md') ? file(outside, 'demo.md', '---\nallowed-tools: Bash(*)\n---')
      : path.endsWith('.JSON') ? file(outside, 'plugin.json', '{"hooks":{}}') : outside;
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    fs.symlinkSync(target, join(root, path));
    caseInsensitiveFilesystem(root);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(scan.findings).toEqual([{
      path: canonical, kind: 'unknown', providers: expect.any(Array), reason: expect.stringMatching(/linked/),
    }]);
    expect(decideProjectConfig(scan, 'claude').decision).toBe('neutralise');
  });

  const pluginCases: Array<{ content: string; kinds: ProjectConfigKind[]; companion?: string }> = [
    { content: JSON.stringify({ name: 'demo', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node demo.js' }] }] } }),
      kinds: ['runs-hooks', 'unknown'] },
    { content: JSON.stringify({ name: 'demo', mcpServers: { demo: { command: 'node', args: ['demo.js'] } } }),
      kinds: ['runs-code', 'unknown'] },
    { content: '{"name":"demo","hooks":"./config/hooks.json"}', kinds: ['runs-hooks', 'unknown'] },
    { content: '{"name":"demo","mcpServers":"./config/mcp.json"}', kinds: ['unknown'] },
    { content: '{"name":"demo"}', kinds: ['unknown'], companion: 'hooks/hooks.json' },
    { content: '{"name":"demo"}', kinds: ['unknown'], companion: '.mcp.json' },
    { content: '{"name":', kinds: ['unknown'] },
  ];

  it.each(pluginCases)('contains embedded Claude skill plugins with manifest $content and companion $companion', ({ content, kinds, companion }) => {
    const root = workspace();
    const path = '.claude/skills/demo/.claude-plugin/plugin.json';
    file(root, '.claude/skills/demo/SKILL.md', 'Demo instructions.');
    file(root, path, content);
    if (companion) file(root, `.claude/skills/demo/${companion}`, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node demo.js' }] }] },
      mcpServers: { demo: { command: 'node', args: ['demo.js'] } },
    }));
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.path === path).map(finding => finding.kind)).toEqual(expect.arrayContaining(kinds));
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      const decision = provider === 'claude' ? 'neutralise' : 'allow';
      expect(result.decision).toBe(decision);
      for (const kind of kinds) expect(result.summary).toContainEqual({
        path, kind, providers: ['claude'], decision, reason: expect.any(String),
      });
      if (provider === 'claude') {
        expect(result.launchOptions).toEqual({ settingSources: ['user'] });
        expect(result.reasons.every(reason => reason.startsWith(`${path}:`))).toBe(true);
      } else expect(result.launchOptions).toBeUndefined();
    }
  });

  it('finds embedded Claude skill plugins through the workspace root', () => {
    const outer = workspace();
    const root = join(outer, 'repo');
    const cwd = join(root, 'packages/demo');
    const path = '.claude/skills/demo/.claude-plugin/plugin.json';
    for (const prefix of ['', 'packages', 'packages/demo']) {
      file(root, join(prefix, '.claude/skills/demo/SKILL.md'), 'Demo instructions.');
      file(root, join(prefix, path), '{"name":"demo"}');
    }
    file(outer, path, '{"name":"demo"}');
    file(root, join('packages/other', path), '{"name":"demo"}');
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.filter(finding => finding.kind === 'unknown').map(finding => finding.path).sort()).toEqual(
      ['', 'packages', 'packages/demo'].map(prefix => join(prefix, path).replaceAll('\\', '/')).sort(),
    );
    expect(decideProjectConfig(scan, 'claude').decision).toBe('neutralise');
  });

  it('bounds reads of embedded Claude plugin manifests', () => {
    const root = workspace();
    const path = '.claude/skills/demo/.claude-plugin/plugin.json';
    file(root, path, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    const open = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path, reason: 'The configuration file exceeds the size limit.' }]);
    expect(open).not.toHaveBeenCalled();
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(['.claude/skills/demo/.claude-plugin', '.claude/skills/demo/.claude-plugin/plugin.json'])(
    'does not follow a linked embedded Claude plugin path %s', path => {
      const root = workspace();
      const outside = workspace();
      const target = path.endsWith('.json') ? file(outside, 'plugin.json', '{"name":"demo","hooks":{}}') : outside;
      file(outside, 'plugin.json', '{"name":"demo","hooks":{}}');
      fs.mkdirSync(join(root, path, '..'), { recursive: true });
      fs.symlinkSync(target, join(root, path));
      const open = vi.spyOn(fs, 'openSync');
      const scan = scanProjectConfig(root, root);
      expect(scan.errors).toEqual([]);
      expect(open).not.toHaveBeenCalled();
      expect(scan.findings).toEqual([{ path, kind: 'unknown', providers: ['claude'], reason: expect.stringMatching(/linked/) }]);
      expect(decideProjectConfig(scan, 'claude').decision).toBe('neutralise');
      for (const provider of PROJECT_CONFIG_PROVIDERS.filter(provider => provider !== 'claude')) {
        expect(decideProjectConfig(scan, provider).decision).toBe('allow');
      }
    });

  it('contains embedded plugin commands without executing them or reading supporting files', () => {
    const root = workspace();
    const path = '.claude/skills/demo/.claude-plugin/plugin.json';
    const marker = join(root, 'plugin-ran');
    file(root, '.claude/skills/demo/SKILL.md', 'Demo instructions.');
    file(root, path, JSON.stringify({ name: 'demo', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }] } }));
    const hook = file(root, '.claude/skills/demo/hooks/hooks.json', '{"hooks":{}}');
    const mcp = file(root, '.claude/skills/demo/.mcp.json', '{"mcpServers":{"demo":{"command":"node"}}}');
    const open = vi.spyOn(fs, 'openSync');
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('neutralise');
    expect(result.launchOptions).toEqual({ settingSources: ['user'] });
    expect(open.mock.calls.some(([path]) => path === hook || path === mcp)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    { content: 'allowed-tools:\n  - Bash(*)', kind: 'grants-permissions' },
    { content: '"allowed-tools": "*"', kind: 'grants-permissions' },
    { content: 'permissionMode: bypassPermissions', kind: 'grants-permissions' },
    { content: 'permission:\n  bash:\n    "git *": allow', kind: 'grants-permissions' },
    { content: 'hooks:\n  PreToolUse:\n    - command: node demo.js', kind: 'runs-hooks' },
    { content: 'mcp-servers: { demo: { command: node } }', kind: 'runs-code' },
  ] as const)('identifies frontmatter behaviour in $content', ({ content, kind }) => {
    const root = workspace();
    const path = '.claude/skills/demo/SKILL.md';
    file(root, path, `\uFEFF---\r\n${content}\r\n---\r\nDemo skill.`);
    const result = checkProjectConfig(root, root, 'copilot');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toContainEqual({
      path, kind, providers: ['claude', 'copilot', 'opencode'], decision: 'refuse', reason: expect.any(String),
    });
  });

  it.each(markdownCases)('bounds reads and fails closed for unsupported frontmatter in $path', ({ path, providers }) => {
    const root = workspace();
    const target = file(root, path, '---\ncustom: [unfinished\n---\nDemo configuration.');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toContainEqual({ path, kind: 'unknown', providers, reason: expect.any(String) });
    for (const provider of providers) expect(decideProjectConfig(scan, provider).decision).not.toBe('allow');
    fs.writeFileSync(target, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    const read = vi.spyOn(fs, 'openSync');
    const result = checkProjectConfig(root, root, 'hermes');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual([`${path}: The configuration file exceeds the size limit.`]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['---\nallowed-tools: Bash(*)', '---\ncustom: true\n---\nDemo skill.', '---\n{}\n---'])('keeps incomplete or unrecognised frontmatter dangerous: %s', content => {
    const root = workspace();
    file(root, '.opencode/agents/demo.md', content);
    const result = checkProjectConfig(root, root, 'opencode');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toContainEqual({
      path: '.opencode/agents/demo.md', kind: 'unknown', providers: ['opencode'], decision: 'refuse', reason: expect.any(String),
    });
  });

  it.each(['\n \n---\npermission: allow\n---', '\uFEFF \n---\npermission: allow\n---', '---\rpermission: allow\r---',
    '--- # configuration\npermission: allow\n---', '---!!map\npermission: allow\n---'])(
    'contains frontmatter with leading whitespace or alternate line endings: %s', content => {
      const root = workspace();
      file(root, '.opencode/agents/demo.md', content);
      const result = checkProjectConfig(root, root, 'opencode');
      expect(result.decision).toBe('refuse');
      expect(result.summary).toContainEqual({
        path: '.opencode/agents/demo.md', kind: 'grants-permissions', providers: ['opencode'], decision: 'refuse', reason: expect.any(String),
      });
    });

  it('keeps plain Markdown and skill supporting files separate from executable configuration', () => {
    const root = workspace();
    file(root, '.claude/skills/demo/SKILL.md', 'Explain allowed-tools, hooks, and permission: allow.');
    file(root, '.claude/skills/demo/scripts/example.sh', 'exit 0');
    file(root, '.claude/skills/demo/reference.md', '---\nallowed-tools: Bash(*)\n---');
    file(root, '.github/agents/team/demo.agent.md', 'Demo instructions.');
    file(root, '.opencode/agents/demo.md', 'Demo instructions.');
    file(root, '.opencode/mode/demo.md', 'Demo instructions.');
    file(root, '.opencode/modes/demo.md', 'Demo instructions.');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toHaveLength(5);
    expect(scan.findings.every(finding => finding.kind === 'instructions')).toBe(true);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('allow');
  });

  it('identifies shell context injection in a Claude command without executing it', () => {
    const root = workspace();
    const path = '.claude/commands/demo.md';
    const marker = join(root, 'command-ran');
    file(root, path, `Inspect !\`touch '${marker}'\`.`);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toContainEqual({ path, kind: 'runs-code', providers: ['claude', 'copilot'], reason: expect.any(String) });
    expect(decideProjectConfig(scan, 'claude').decision).toBe('neutralise');
    expect(decideProjectConfig(scan, 'copilot').decision).toBe('refuse');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ...markdownCases.map(({ path }) => path),
    '.claude/skills', '.claude/skills/demo', '.claude/commands', '.github/skills', '.github/agents',
    '.agents', '.agents/skills', '.opencode/agents', '.opencode/agent', '.opencode/mode', '.opencode/modes', '.opencode/skills', '.opencode/commands',
  ])('does not follow a linked Markdown configuration path %s', path => {
    const root = workspace();
    const outside = workspace();
    const target = path.endsWith('.md') ? file(outside, 'demo.md', '---\nallowed-tools: Bash(*)\n---') : outside;
    file(outside, 'demo/SKILL.md', '---\nallowed-tools: Bash(*)\n---');
    file(outside, 'demo.agent.md', '---\nmcp-servers: { demo: { command: node } }\n---');
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    fs.symlinkSync(target, join(root, path));
    const read = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(scan.findings).toContainEqual({ path, kind: 'unknown', providers: expect.any(Array), reason: expect.stringMatching(/linked/) });
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      if (scan.findings[0]!.providers.includes(provider)) {
        expect(decideProjectConfig(scan, provider).decision).toBe(provider === 'claude' ? 'neutralise' : 'refuse');
      }
    }
  });

  it.each(['.claude/skills/demo/SKILL.md', '.claude/skills/demo/.claude-plugin/plugin.json', '.github/agents/demo.agent.md',
    '.opencode/agents/build.md', '.opencode/mode/build.md', '.opencode/modes/build.md'])(
    'fails closed when %s cannot be read', path => {
      const root = workspace();
      const target = file(root, path, '---\ncustom: true\n---');
      const original = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
        if (path === target) throw Object.assign(new Error('Cannot read demo configuration'), { code: 'EACCES' });
        return original(path, flags, mode);
      });
      const scan = scanProjectConfig(root, root);
      expect(scan.errors).toEqual([{ path, reason: 'The configuration file could not be read.' }]);
      for (const provider of PROJECT_CONFIG_PROVIDERS) {
        const result = decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true });
        expect(result.decision).toBe('refuse');
        expect(result.launchOptions).toBeUndefined();
      }
    });

  it.each(['.claude/skills/demo/SKILL.md', '.claude/skills/demo/.claude-plugin/plugin.json', '.github/agents/demo.agent.md',
    '.opencode/agents/build.md', '.opencode/mode/build.md', '.opencode/modes/build.md'])(
    'detects late creation of %s even with unchanged directory timestamps', path => {
      const root = workspace();
      fs.mkdirSync(join(root, path, '..'), { recursive: true });
      const original = fs.lstatSync;
      const directoryStats = new Map<string, fs.Stats>();
      for (let parent = join(root, path, '..'); ; parent = paths.dirname(parent)) {
        directoryStats.set(parent, original(parent));
        if (parent === root) break;
      }
      let changed = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation((probe, options) => {
        if (probe === join(root, 'CLAUDE.md') && !changed) {
          changed = true;
          file(root, path, '---\nallowed-tools: Bash(*)\n---');
        }
        return directoryStats.get(String(probe)) ?? original(probe, options as never);
      });
      const scan = scanProjectConfig(root, root);
      expect(changed).toBe(true);
      expect(scan.errors).toEqual([path.endsWith('.json') || path.endsWith('/SKILL.md')
        ? { path, reason: 'The configuration path changed during the scan.' }
        : { path: join(path, '..').replaceAll('\\', '/'), reason: 'The configuration directory entries changed during the scan.' }]);
      for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
    });

  it('bounds the total bytes read from Markdown configuration', () => {
    const root = workspace();
    for (let i = 0; i < 9; i++) file(root, `.github/agents/demo-${i}.agent.md`, 'x'.repeat(MAX_PROJECT_CONFIG_BYTES));
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: expect.stringContaining('.github/agents'), reason: 'The configuration scan exceeded its size limit.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it('scans a repository carrying all configuration types without running its code', () => {
    const root = workspace();
    for (const { path, content } of cases) file(root, path, content);
    const marker = join(root, 'hook-ran');
    file(root, '.github/hooks/pre-tool-use.sh', `#!/bin/sh\ntouch '${marker}'\nprintf '{"permissionDecision":"allow"}\\n'\n`);
    file(root, '.opencode/plugins/demo.js', 'throw new Error("Plugin must not run during a scan");');
    file(root, '.cursor/hooks.json', '{"hooks":{}}');
    file(root, '.cursor/hooks.local.json', '{"hooks":{}}');
    file(root, 'AGENTS.md', 'Use the project style.');
    file(root, 'CLAUDE.md', 'Use the project style.');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    for (const { path } of cases) expect(scan.findings.some(finding => finding.path === path)).toBe(true);
    expect(decideProjectConfig(scan, 'claude').decision).toBe('neutralise');
    expect(decideProjectConfig(scan, 'opencode').decision).toBe('refuse');
    expect(decideProjectConfig(scan, 'opencode', { opencodeProjectConfigDisable: true }).decision).toBe('neutralise');
    for (const provider of ['copilot', 'codex', 'gemini', 'pi'] as const) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
    expect(decideProjectConfig(scan, 'hermes').decision).toBe('allow');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(['hooks.json', 'hooks.local.json', 'hooks-demo.json'])('identifies Cursor %s without assigning it to another provider', name => {
    const root = workspace();
    file(root, `.cursor/${name}`, '{}');
    file(root, '.cursor/settings.json', '{}');
    const scan = scanProjectConfig(root, root);
    expect(scan.findings).toContainEqual({ path: `.cursor/${name}`, kind: 'runs-hooks', providers: ['cursor'], reason: expect.any(String) });
    expect(scan.findings.some(finding => finding.path === '.cursor/settings.json')).toBe(false);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('allow');
  });

  it('lists markdown instructions without reading their contents or blocking any provider', () => {
    const root = workspace();
    file(root, 'AGENTS.md', 'hooks: run a command\npermissions: bypassPermissions');
    fs.symlinkSync(join(root, 'missing'), join(root, 'CLAUDE.md'));
    const read = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(read).not.toHaveBeenCalled();
    expect(scan.findings).toEqual([
      { path: 'AGENTS.md', kind: 'instructions', providers: [...PROJECT_CONFIG_PROVIDERS], reason: 'Instruction text only.' },
      { path: 'CLAUDE.md', kind: 'instructions', providers: [...PROJECT_CONFIG_PROVIDERS], reason: 'Instruction text only.' },
    ]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('allow');
  });

  it('includes every parent through the workspace root and excludes its parent and sibling folders', () => {
    const outer = workspace();
    const root = join(outer, 'repo');
    const cwd = join(root, 'packages/demo/src');
    fs.mkdirSync(cwd, { recursive: true });
    file(outer, '.codex/config.toml', 'approval_policy = "never"');
    file(root, '.claude/settings.json', '{"hooks":{}}');
    file(root, 'packages/.gemini/settings.json', '{"hooks":{}}');
    file(root, 'packages/demo/.mcp.json', '{"mcpServers":{"demo":{"command":"node"}}}');
    file(cwd, 'AGENTS.md', 'Demo instructions.');
    file(root, 'packages/other/.github/hooks/demo.json', '{"hooks":{}}');
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.map(finding => finding.path)).toEqual([
      '.claude/settings.json', 'packages/.gemini/settings.json', 'packages/demo/.mcp.json', 'packages/demo/src/AGENTS.md',
    ]);
    expect(decideProjectConfig(scan, 'codex').decision).toBe('allow');
    expect(decideProjectConfig(scan, 'gemini').decision).toBe('refuse');
  });

  it.each(['.github/mcp.json', '.github/copilot/settings.json', '.github/copilot/settings.local.json',
    'opencode.json', 'opencode.jsonc', '.opencode/opencode.jsonc', '.opencode/tool/demo.js', '.opencode/tools/demo.ts'])(
    'contains %s at the worker folder, its parent, and the workspace root', path => {
      const root = workspace();
      const cwd = join(root, 'packages/demo');
      const content = cases.find(item => item.path === path)!.content;
      for (const prefix of ['', 'packages', 'packages/demo']) file(root, join(prefix, path), content);
      const provider = path.startsWith('.github') ? 'copilot' : 'opencode';
      const result = checkProjectConfig(cwd, root, provider);
      expect(result.decision).toBe('refuse');
      for (const prefix of ['', 'packages', 'packages/demo']) {
        expect(result.summary).toContainEqual({
          path: join(prefix, path).replaceAll('\\', '/'), kind: expect.any(String), providers: [provider],
          decision: 'refuse', reason: expect.any(String),
        });
      }
    });

  it.each([
    { root: 'C:\\Repo', cwd: 'c:\\Repo\\pkg' },
    { root: 'C:\\Repo', cwd: 'C:\\repo\\pkg' },
    { root: 'C:\\Repo', cwd: 'c:\\rEPO' },
    { root: '\\\\server\\share\\Repo', cwd: '\\\\SERVER\\SHARE\\repo\\pkg' },
    { root: '\\\\server\\share\\Repo', cwd: '\\\\SERVER\\SHARE\\repo' },
  ])('stops at the Windows workspace boundary $root from $cwd', ({ root, cwd }) => {
    const info = fs.lstatSync(workspace());
    const directories = new Set<string>();
    for (let path = paths.win32.resolve(cwd); ; path = paths.win32.dirname(path)) {
      directories.add(path.toLowerCase());
      if (path === paths.win32.dirname(path)) break;
    }
    for (const name of ['resolve', 'relative', 'join', 'dirname', 'isAbsolute'] as const) {
      vi.spyOn(paths, name).mockImplementation(paths.win32[name] as never);
    }
    const probes: string[] = [];
    vi.spyOn(fs, 'lstatSync').mockImplementation(path => {
      const name = String(path);
      probes.push(name);
      if (directories.has(name.toLowerCase())) return info;
      throw Object.assign(new Error('Missing demo path'), { code: 'ENOENT' });
    });
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings).toEqual([]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('allow');
    expect(probes.some(path => paths.win32.relative(root, path) === '.codex')).toBe(true);
    expect(probes.every(path => directories.has(path.toLowerCase()) ||
      !paths.win32.relative(root, path).startsWith('..'))).toBe(true);
  });

  it.each([
    { root: 'C:\\Repo', cwd: 'C:\\Other\\pkg' },
    { root: 'C:\\Repo', cwd: 'D:\\Repo\\pkg' },
    { root: '\\\\server\\share\\Repo', cwd: '\\\\server\\other\\Repo' },
  ])('refuses the Windows folder $cwd outside $root before inspecting it', ({ root, cwd }) => {
    for (const name of ['resolve', 'relative', 'join', 'dirname', 'isAbsolute'] as const) {
      vi.spyOn(paths, name).mockImplementation(paths.win32[name] as never);
    }
    const inspect = vi.spyOn(fs, 'lstatSync');
    const result = checkProjectConfig(cwd, root, 'copilot');
    expect(result.decision).toBe('refuse');
    expect(result.reasons[0]).toContain('The worker folder is outside the workspace root.');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('stops at the filesystem root if path traversal cannot reach the workspace boundary', () => {
    const root = workspace();
    const info = fs.lstatSync(root);
    const originalRelative = paths.relative;
    vi.spyOn(paths, 'relative').mockImplementation((from, to) => to === root ? 'demo' : originalRelative(from, to));
    vi.spyOn(paths, 'dirname').mockImplementation(() => root);
    vi.spyOn(fs, 'lstatSync').mockImplementation(path => {
      if (path === root) return info;
      throw Object.assign(new Error('Missing demo path'), { code: 'ENOENT' });
    });
    const result = checkProjectConfig(root, root, 'hermes');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['demo: The workspace root could not be reached.']);
  });

  it.each(['.claude', '.claude/settings.json', '.claude/hooks', '.github/hooks', '.github/mcp.json', '.github/copilot',
    '.github/copilot/settings.json', 'opencode.json', 'opencode.jsonc', '.opencode/opencode.jsonc',
    '.opencode/plugins', '.opencode/tool', '.opencode/tools', '.pi'])('does not follow a linked %s', path => {
    const root = workspace();
    const outside = workspace();
    const target = /\.jsonc?$/.test(path) ? file(outside, 'settings.json', '{"hooks":{}}') : outside;
    file(outside, 'settings.json', '{"hooks":{}}');
    file(outside, 'allow.sh', 'exit 0');
    fs.mkdirSync(join(root, path, '..'), { recursive: true });
    fs.symlinkSync(target, join(root, path));
    const read = vi.spyOn(fs, 'openSync');
    const scan = scanProjectConfig(root, root);
    expect(read).not.toHaveBeenCalled();
    expect(scan.findings).toContainEqual({ path, kind: 'unknown', providers: expect.any(Array), reason: expect.stringMatching(/linked/) });
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      if (!scan.findings.find(finding => finding.path === path)!.providers.includes(provider)) continue;
      expect(decideProjectConfig(scan, provider).decision).toBe(provider === 'claude' ? 'neutralise' : 'refuse');
    }
  });

  it.each(['.claude/settings.local.json', '.codex/hooks.json', '.gemini/settings.json', '.opencode/opencode.json', '.mcp.json'])('treats unparseable %s as dangerous', path => {
    const root = workspace();
    file(root, path, '{broken');
    const scan = scanProjectConfig(root, root);
    expect(scan.findings).toContainEqual({ path, kind: 'unknown', providers: expect.any(Array), reason: expect.any(String) });
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      if (scan.findings[0]!.providers.includes(provider)) expect(decideProjectConfig(scan, provider).decision).not.toBe('allow');
    }
  });

  it.each(['.mcp.json', '.github/mcp.json'])('classifies commands in the bare MCP format in %s', path => {
    const root = workspace();
    file(root, path, '{"demo":{"command":"node","args":["demo.js"]}}');
    const result = checkProjectConfig(root, root, 'copilot');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toContainEqual({
      path, kind: 'runs-code', providers: expect.arrayContaining(['copilot']), decision: 'refuse', reason: expect.any(String),
    });
  });

  it.each(['opencode.jsonc', '.opencode/opencode.jsonc'])('classifies comments and trailing commas in %s', path => {
    const root = workspace();
    file(root, path, `{
      // Project settings
      "permission": { "bash": "allow", },
      "plugin": ["./demo.js", /* load a local module */ ],
    }`);
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([]);
    expect(scan.findings.map(finding => finding.kind)).toEqual(['grants-permissions', 'runs-code']);
    expect(decideProjectConfig(scan, 'opencode').decision).toBe('refuse');
    expect(decideProjectConfig(scan, 'opencode', { opencodeProjectConfigDisable: true }).launchOptions)
      .toEqual({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: 'true' } });
  });

  it.each([
    '{/* unfinished', '{"permission": {"bash": "allow"} broken}',
    '{"value":"unterminated}', '{"value": "comma,}", "url": "https://example.com/*demo*/",}',
    '{"value": "escaped \\\" // still a string,}",}',
  ])('keeps malformed or unsupported JSONC dangerous: %s', content => {
    const root = workspace();
    file(root, 'opencode.jsonc', content);
    const result = checkProjectConfig(root, root, 'opencode');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toEqual([{
      path: 'opencode.jsonc', kind: 'unknown', providers: ['opencode'], decision: 'refuse', reason: expect.any(String),
    }]);
  });

  it.each(['.github/mcp.json', '.github/copilot/settings.json', '.github/copilot/settings.local.json',
    'opencode.json', 'opencode.jsonc', '.opencode/opencode.jsonc'])(
    'bounds reads of %s and refuses malformed configuration', path => {
      const root = workspace();
      const provider = path.startsWith('.github') ? 'copilot' : 'opencode';
      const target = file(root, path, '{broken');
      expect(checkProjectConfig(root, root, provider).summary).toContainEqual({
        path, kind: 'unknown', providers: [provider], decision: 'refuse', reason: expect.any(String),
      });
      fs.writeFileSync(target, ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
      const read = vi.spyOn(fs, 'openSync');
      const result = checkProjectConfig(root, root, provider);
      expect(result.decision).toBe('refuse');
      expect(result.reasons).toEqual([`${path}: The configuration file exceeds the size limit.`]);
      expect(read).not.toHaveBeenCalled();
    });

  it.each([
    { text: '[hooks.PreToolUse]\ncommand = "demo"', kind: 'runs-hooks' },
    { text: '[[hooks.PreToolUse]]\ncommand = "demo"', kind: 'runs-hooks' },
    { text: '[permissions]\nallow = ["read", "write"]', kind: 'grants-permissions' },
    { text: 'default_mode = "acceptEdits"', kind: 'grants-permissions' },
    { text: 'skip_permissions = true', kind: 'grants-permissions' },
    { text: '[mcp_servers.demo]\ncommand = "node"', kind: 'runs-code' },
    { text: 'not TOML', kind: 'unknown' },
    { text: '[hooks', kind: 'unknown' },
    { text: 'model = "unfinished', kind: 'unknown' },
    { text: 'approval_policy = "never"\napproval_policy = "ask"', kind: 'unknown' },
    { text: 'value = { nested = true }', kind: 'unknown' },
  ] as const)('conservatively scans TOML $text', ({ text, kind }) => {
    const root = workspace();
    file(root, '.codex/config.toml', text);
    const result = checkProjectConfig(root, root, 'codex');
    expect(result.decision).toBe('refuse');
    expect(result.summary).toContainEqual({ path: '.codex/config.toml', kind, providers: ['codex'], decision: 'refuse', reason: expect.any(String) });
  });

  it.each([
    { dangerouslySkipPermissions: true },
    { permissionMode: 'bypassPermissions' },
    { permissions: { defaultMode: 'acceptEdits' } },
    { allowedTools: ['Bash(*)'] },
    { tools: { allowed: ['shell'] } },
    { permission: { edit: 'allow' } },
    { env: { SKIP_PERMISSION_CHECKS: '1' } },
  ])('detects JSON permission grants %j', settings => {
    const root = workspace();
    file(root, '.claude/settings.json', JSON.stringify(settings));
    expect(checkProjectConfig(root, root, 'claude').summary).toContainEqual({
      path: '.claude/settings.json', kind: 'grants-permissions', providers: ['claude', 'copilot'], decision: 'neutralise', reason: expect.any(String),
    });
  });

  it.each(['null', '[]', '"demo"', '{}', '{"unrecognised":true}'])('keeps unsupported JSON settings %s dangerous', content => {
    const root = workspace();
    file(root, '.gemini/settings.json', content);
    expect(checkProjectConfig(root, root, 'gemini').decision).toBe('refuse');
  });

  it('fails closed for every provider when a configuration cannot be inspected', () => {
    const root = workspace();
    const target = file(root, '.claude/settings.json', '{"hooks":{}}');
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
      if (path === target) throw Object.assign(new Error('Cannot inspect demo configuration'), { code: 'EACCES' });
      return original(path, options as never);
    });
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: '.claude/settings.json', reason: 'The configuration path could not be inspected.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) {
      const result = decideProjectConfig(scan, provider);
      expect(result.decision).toBe('refuse');
      expect(result.launchOptions).toBeUndefined();
      expect(result.reasons).toEqual(['.claude/settings.json: The configuration path could not be inspected.']);
    }
  });

  it('names a configuration that cannot be opened and refuses even providers that do not load it', () => {
    const root = workspace();
    const target = file(root, '.gemini/settings.json', '{"hooks":{}}');
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (path === target) throw Object.assign(new Error('Cannot read demo configuration'), { code: 'EACCES' });
      return original(path, flags, mode);
    });
    const result = checkProjectConfig(root, root, 'hermes');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['.gemini/settings.json: The configuration file could not be read.']);
  });

  it('rejects oversized settings before opening the file', () => {
    const root = workspace();
    file(root, '.claude/settings.json', ' '.repeat(MAX_PROJECT_CONFIG_BYTES + 1));
    const read = vi.spyOn(fs, 'openSync');
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['.claude/settings.json: The configuration file exceeds the size limit.']);
    expect(read).not.toHaveBeenCalled();
  });

  it('bounds the total bytes read across configuration files', () => {
    const root = workspace();
    const content = JSON.stringify({ hooks: {}, demo: 'x'.repeat(MAX_PROJECT_CONFIG_BYTES - 32) });
    for (let i = 0; i < 9; i++) file(root, `.github/hooks/demo-${i}.json`, content);
    const result = checkProjectConfig(root, root, 'hermes');
    expect(result.decision).toBe('refuse');
    expect(result.reasons.some(reason => reason.endsWith('The configuration scan exceeded its size limit.'))).toBe(true);
  });

  it('refuses when a file grows beyond the size cap while it is being read', () => {
    const root = workspace();
    const target = file(root, '.claude/settings.json', '{"hooks":{}}');
    const original = fs.readSync;
    let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation((fd: number, buffer: NodeJS.ArrayBufferView,
      offset?: number | fs.ReadOptions, length?: number, position?: fs.ReadPosition | null) => {
      const count = typeof offset === 'number' ? original(fd, buffer, offset, length!, position ?? null)
        : original(fd, buffer, offset);
      if (!changed) { changed = true; fs.appendFileSync(target, ' '.repeat(MAX_PROJECT_CONFIG_BYTES)); }
      return count;
    });
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['.claude/settings.json: The configuration scan exceeded its size limit.']);
  });

  it('fails closed when a hook directory cannot be enumerated', () => {
    const root = workspace();
    file(root, '.github/hooks/demo.sh', 'exit 0');
    vi.spyOn(fs, 'opendirSync').mockImplementation(() => { throw new Error('Cannot enumerate demo hooks'); });
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: '.github/hooks', reason: 'The configuration directory could not be scanned.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it('does not read a settings file swapped for a symlink before opening it', () => {
    const root = workspace();
    const target = file(root, '.claude/settings.json', '{"hooks":{}}');
    const outside = file(workspace(), 'demo.json', '{"hooks":{}}');
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (path === target) { fs.unlinkSync(target); fs.symlinkSync(outside, target); }
      return original(path, flags, mode);
    });
    const read = vi.spyOn(fs, 'readSync');
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['.claude/settings.json: The configuration file could not be read.']);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a file replaced while it is being read and closes the descriptor', () => {
    const root = workspace();
    const target = file(root, '.claude/settings.json', '{"hooks":{}}');
    const original = fs.readSync;
    let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation((fd: number, buffer: NodeJS.ArrayBufferView,
      offset?: number | fs.ReadOptions, length?: number, position?: fs.ReadPosition | null) => {
      const count = typeof offset === 'number' ? original(fd, buffer, offset, length!, position ?? null)
        : original(fd, buffer, offset);
      if (!changed) {
        changed = true;
        fs.renameSync(target, `${target}.old`);
        fs.writeFileSync(target, '{}');
      }
      return count;
    });
    const close = vi.spyOn(fs, 'closeSync');
    const result = checkProjectConfig(root, root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.reasons).toEqual(['.claude/settings.json: The configuration file changed during the scan.']);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['missing-directory', 'missing-file', 'linked-directory', 'existing-file', 'hook-file', 'ancestor'])(
    'fails closed when a %s changes after its probe', kind => {
      const root = workspace();
      const cwd = kind === 'ancestor' ? join(root, 'packages/demo') : root;
      fs.mkdirSync(cwd, { recursive: true });
      if (kind === 'missing-file') fs.mkdirSync(join(root, '.codex'));
      if (kind === 'existing-file') file(root, '.mcp.json', '{"mcpServers":{"demo":{"command":"node"}}}');
      if (kind === 'hook-file') file(root, '.github/hooks/demo.sh', 'exit 0');
      const outside = kind === 'linked-directory' ? workspace() : undefined;
      const original = fs.lstatSync;
      let changed = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
        if (path === join(cwd, 'CLAUDE.md') && !changed) {
          changed = true;
          if (kind === 'linked-directory') fs.symlinkSync(outside!, join(root, '.codex'));
          else if (kind === 'existing-file' || kind === 'hook-file') {
            const target = join(root, kind === 'existing-file' ? '.mcp.json' : '.github/hooks/demo.sh');
            fs.renameSync(target, `${target}.old`);
            fs.writeFileSync(target, kind === 'existing-file' ? '{}' : 'exit 1');
          } else if (kind === 'ancestor') {
            fs.renameSync(join(root, 'packages'), join(root, 'previous-packages'));
            fs.mkdirSync(cwd, { recursive: true });
          } else file(root, '.codex/config.toml', 'approval_policy = "never"');
        }
        return original(path, options as never);
      });
      const scan = scanProjectConfig(cwd, root);
      expect(changed).toBe(true);
      expect(scan.errors).toContainEqual({ path: expect.any(String), reason: expect.stringMatching(/changed during the scan/) });
      for (const provider of PROJECT_CONFIG_PROVIDERS) {
        expect(decideProjectConfig(scan, provider, { opencodeProjectConfigDisable: true }).decision).toBe('refuse');
      }
    });

  it('detects additions made during the final missing-path recheck', () => {
    const root = workspace();
    const timestamp = fs.lstatSync(root).mtimeMs / 1000 + 1;
    const original = fs.lstatSync;
    let probes = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
      try { return original(path, options as never); }
      catch (err) {
        if (path === join(root, '.codex') && ++probes === 2) {
          file(root, '.codex/config.toml', 'approval_policy = "never"');
          fs.utimesSync(root, timestamp, timestamp);
        }
        throw err;
      }
    });
    const scan = scanProjectConfig(root, root);
    expect(probes).toBe(2);
    expect(scan.errors).toEqual([{ path: '.', reason: 'The configuration path changed during the scan.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it('detects new hook files even when directory timestamps do not change', () => {
    const root = workspace();
    fs.mkdirSync(join(root, '.cursor'));
    const original = fs.lstatSync;
    const directoryStats = new Map([root, join(root, '.cursor')].map(path => [path, original(path)]));
    let changed = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
      if (path === join(root, 'CLAUDE.md') && !changed) {
        changed = true;
        file(root, '.cursor/hooks.late.json', '{"hooks":{}}');
      }
      return directoryStats.get(String(path)) ?? original(path, options as never);
    });
    const scan = scanProjectConfig(root, root);
    expect(changed).toBe(true);
    expect(scan.errors).toEqual([{ path: '.cursor', reason: 'The configuration directory entries changed during the scan.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it('allows unrelated directory changes above the workspace root', () => {
    const outer = workspace();
    const root = join(outer, 'repo');
    fs.mkdirSync(root);
    const timestamp = fs.lstatSync(outer).mtimeMs / 1000 + 1;
    const original = fs.lstatSync;
    let changed = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
      if (path === join(root, 'CLAUDE.md') && !changed) {
        changed = true;
        file(outer, 'unrelated/demo.txt', 'Demo content.');
        fs.utimesSync(outer, timestamp, timestamp);
      }
      return original(path, options as never);
    });
    const result = checkProjectConfig(root, root, 'copilot');
    expect(changed).toBe(true);
    expect(result.decision).toBe('allow');
    expect(result.summary).toEqual([]);
  });

  it('bounds directory enumeration and fails closed instead of returning a partial allow', () => {
    const root = workspace();
    for (let i = 0; i < 600; i++) file(root, `.github/hooks/demo-${i}.sh`, 'exit 0');
    const scan = scanProjectConfig(root, root);
    expect(scan.errors).toEqual([{ path: expect.stringContaining('.github/hooks'), reason: 'The configuration scan exceeded its entry limit.' }]);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it.each(['missing', 'outside', 'linked', 'file'])('refuses a %s worker folder for every provider', kind => {
    const root = workspace();
    let cwd = join(root, 'missing');
    if (kind === 'outside') cwd = workspace();
    if (kind === 'linked') { cwd = join(root, 'linked'); fs.symlinkSync(workspace(), cwd); }
    if (kind === 'file') cwd = file(root, 'file', 'Demo content.');
    const scan = scanProjectConfig(cwd, root);
    expect(scan.errors).toHaveLength(1);
    for (const provider of PROJECT_CONFIG_PROVIDERS) expect(decideProjectConfig(scan, provider).decision).toBe('refuse');
  });

  it('rejects a linked ancestor without opening configuration outside the workspace', () => {
    const root = workspace();
    const outside = workspace();
    fs.mkdirSync(join(outside, 'demo'));
    file(outside, 'demo/.mcp.json', '{"mcpServers":{"demo":{"command":"node"}}}');
    fs.symlinkSync(outside, join(root, 'packages'));
    const read = vi.spyOn(fs, 'openSync');
    const result = checkProjectConfig(join(root, 'packages/demo'), root, 'claude');
    expect(result.decision).toBe('refuse');
    expect(result.reasons[0]).toMatch(/^packages: A parent is missing, linked, or not a directory\./);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns only task-card metadata, with one reason for every dangerous file', () => {
    const root = workspace();
    file(root, '.claude/settings.json', '{"hooks":{},"permissions":{"allow":["Bash(*)"]}}');
    file(root, '.claude/settings.local.json', '{"permissionMode":"bypassPermissions"}');
    const result = checkProjectConfig(root, root, 'copilot');
    expect(result.decision).toBe('refuse');
    expect(result.summary.every(row => Object.keys(row).sort().join(',') === 'decision,kind,path,providers,reason')).toBe(true);
    for (const path of ['.claude/settings.json', '.claude/settings.local.json']) {
      expect(result.reasons.some(reason => reason.startsWith(`${path}:`))).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain('Bash(*)');
    expect(JSON.stringify(result)).not.toContain(relative(process.cwd(), root));
  });
});
