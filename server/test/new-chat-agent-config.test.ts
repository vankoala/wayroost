import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PaseoOptions } from '../../shared/protocol.js';
import * as projectConfig from '../src/hub/project-config-notice.js';
import { projectConfigNotices, type ProjectConfigScanner } from '../src/hub/project-config-notice.js';
import type { ProjectConfigFinding } from '../src/hub/project-config.js';
import { makeApp, makeKeys, makeToken, postHeaders, TEST_DESKTOP, type Keys } from './helpers.js';

// What a folder says about itself before an agent starts working in it. The folders here are made
// while the test runs, under a temporary directory: files named like an agent's own configuration
// belong to a folder being checked, never to this checkout.

let keys: Keys;
let token: string;
const apps: Array<{ close(): Promise<unknown> }> = [];
const folders: string[] = [];
beforeAll(async () => {
  keys = await makeKeys();
  token = await makeToken(keys);
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true });
});

/** A folder with its own files, planted at run time. */
function plant(files: Record<string, string>, gitMarker = true): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-folder-config-'));
  folders.push(root);
  if (gitMarker) mkdirSync(join(root, '.git'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const finding = (path: string, kind: ProjectConfigFinding['kind'], providers: string[]): ProjectConfigFinding => ({
  path,
  kind,
  providers: providers as ProjectConfigFinding['providers'],
  reason: `Planted as ${kind}.`,
});

async function ask(path: string, provider = 'claude', configScan?: ProjectConfigScanner, workspaceRoot?: string) {
  const ctx = await makeApp(keys, { configScan: configScan ?? (folder => projectConfig.scanFolderProjectConfig(folder, workspaceRoot ? [workspaceRoot] : [])) });
  apps.push(ctx.app);
  if (workspaceRoot) vi.spyOn(ctx.paseo, 'options').mockResolvedValue({ providers: [], workspaces: [{ path: workspaceRoot, label: 'app' }] });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/project-config',
    headers: postHeaders(token),
    payload: JSON.stringify({ path, provider }),
  });
  return { status: res.statusCode, body: res.json() as unknown };
}

describe('a folder read before an agent starts in it', () => {
  it('says nothing about an ordinary folder', async () => {
    const folder = plant({ 'README.md': 'A project.\n', 'src/app.ts': 'export const a = 1;\n' });
    expect(await ask(folder)).toEqual({ status: 200, body: { notices: [] } });
    expect(projectConfigNotices([], 'claude')).toEqual([]);
  });

  it('is quiet when all the folder holds is instructions to read', async () => {
    const folder = plant({
      'AGENTS.md': 'Run the tests before committing.\n',
      'CLAUDE.md': 'Two spaces, no semicolons.\n',
      '.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" } }\n',
    });
    // Only the settings file is worth a sentence; AGENTS.md and CLAUDE.md are not.
    expect(await ask(folder)).toEqual({
      status: 200,
      body: { notices: [{ text: 'Files here can give Claude Code permission to act without asking.', files: ['.claude/settings.json'] }] },
    });
  });

  it('says what the agent about to start would be handed', async () => {
    const folder = plant({
      '.claude/hooks.json': '{ "hooks": { "PreToolUse": [{ "command": "./check.sh" }] } }\n',
    });
    expect(await ask(folder, 'claude')).toEqual({
      status: 200,
      body: { notices: [{ text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/hooks.json'] }] },
    });
  });

  it.each(['directory', 'file'])('includes inherited configuration inside a Git workspace with a %s marker', async (marker) => {
    const root = plant({
      '.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" }, "hooks": {} }\n',
      'src/app.ts': 'export const a = 1;\n',
    }, false);
    if (marker === 'directory') mkdirSync(join(root, '.git'));
    else writeFileSync(join(root, '.git'), 'gitdir: /home/me/worktree.git\n');
    expect(await ask(join(root, 'src'))).toEqual({
      status: 200,
      body: { notices: [
        { text: 'Files here can give Claude Code permission to act without asking.', files: ['.claude/settings.json'] },
        { text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/settings.json'] },
      ] },
    });
  });

  it.each(['directory', 'file'])('includes Git configuration above a nested Paseo marker with a %s Git marker', async (marker) => {
    const parent = plant({
      '.claude/hooks.json': '{ "hooks": {} }\n',
      'app/.claude/settings.json': '{ "hooks": {} }\n',
      'app/src/paseo.json': '{ "scripts": { "setup": "./prepare.sh" } }\n',
      'app/src/nested/app.ts': 'export const a = 1;\n',
    }, false);
    const root = join(parent, 'app');
    if (marker === 'directory') mkdirSync(join(root, '.git'));
    else writeFileSync(join(root, '.git'), 'gitdir: /home/me/worktree.git\n');
    expect(await ask(join(root, 'src/nested'))).toEqual({
      status: 200,
      body: { notices: [
        { text: 'This folder has code Paseo runs on its own.', files: ['src/paseo.json'] },
        { text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/settings.json'] },
      ] },
    });
  });

  it.each(['directory', 'file', 'missing', 'loop'])('includes inherited configuration beneath a linked Git marker with a %s target', async (target) => {
    const parent = plant({
      '.claude/hooks.json': '{ "hooks": {} }\n',
      'app/.claude/settings.json': '{ "hooks": {} }\n',
      'app/src/nested/app.ts': 'export const a = 1;\n',
    });
    const root = join(parent, 'app');
    const gitTarget = join(parent, 'git-target');
    if (target === 'directory') {
      mkdirSync(join(gitTarget, '.claude'), { recursive: true });
      writeFileSync(join(gitTarget, '.claude/settings.json'), '{ "permissions": { "defaultMode": "bypassPermissions" } }\n');
    } else if (target === 'file') writeFileSync(gitTarget, 'gitdir: /home/me/worktree.git\n');
    symlinkSync(target === 'loop' ? '.git' : '../git-target', join(root, '.git'));
    const expected = {
      status: 200,
      body: { notices: [
        { text: 'This folder has hooks Claude Code runs without asking.', files: ['.claude/settings.json'] },
      ] },
    };
    expect(await ask(join(root, 'src/nested'))).toEqual(expected);
    writeFileSync(join(root, 'src/paseo.json'), '{ "scripts": { "setup": "./prepare.sh" } }\n');
    expect(await ask(join(root, 'src/nested'))).toEqual({
      status: 200,
      body: { notices: [
        { text: 'This folder has code Paseo runs on its own.', files: ['src/paseo.json'] },
        ...expected.body.notices,
      ] },
    });
  });

  it('uses the containing Paseo workspace and stops at its boundary', async () => {
    const parent = plant({
      '.claude/hooks.json': '{ "hooks": {} }\n',
      'app/.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" } }\n',
      'app/src/app.ts': 'export const a = 1;\n',
    }, false);
    const root = join(parent, 'app');
    expect(await ask(join(root, 'src'), 'claude', undefined, root)).toEqual({
      status: 200,
      body: { notices: [{ text: 'Files here can give Claude Code permission to act without asking.', files: ['.claude/settings.json'] }] },
    });
  });

  it('does not read configuration if the device is revoked while its workspace is being resolved', async () => {
    const ctx = await makeApp(keys);
    apps.push(ctx.app);
    let ready!: () => void;
    let resolve!: (options: PaseoOptions) => void;
    const started = new Promise<void>((yes) => { ready = yes; });
    const pending = new Promise<PaseoOptions>((yes) => { resolve = yes; });
    vi.spyOn(ctx.paseo, 'options').mockImplementation(() => { ready(); return pending; });
    const scan = vi.spyOn(projectConfig, 'scanFolderProjectConfig').mockReturnValue({ findings: [], errors: [] });
    const response = ctx.app.inject({
      method: 'POST', url: '/api/project-config', headers: postHeaders(token),
      payload: JSON.stringify({ path: '/home/me/code/app', provider: 'claude' }),
    }).then((res) => res);
    await started;
    ctx.devices!.revoke(TEST_DESKTOP.id);
    resolve({ providers: [], workspaces: [] });
    expect((await response).statusCode).toBe(403);
    expect(scan).not.toHaveBeenCalled();
  });

  it('says nothing about configuration this agent does not read', async () => {
    const folder = plant({ '.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" } }\n' });
    expect(await ask(folder, 'codex')).toEqual({ status: 200, body: { notices: [] } });
  });

  it('says what runs on its own whatever agent is chosen', async () => {
    const folder = plant({
      'paseo.json': '{ "scripts": { "setup": "./prepare.sh" } }\n',
      '.vscode/tasks.json': '{ "tasks": [{ "command": "echo hello", "runOn": "folderOpen" }] }\n',
    });
    expect(await ask(folder, 'codex')).toEqual({
      status: 200,
      body: {
        notices: [
          { text: 'This folder has code Paseo runs on its own.', files: ['paseo.json'] },
          { text: 'This folder has code VS Code runs on its own.', files: ['.vscode/tasks.json'] },
        ],
      },
    });
  });

  it('names the files, never what is written in them', async () => {
    const folder = plant({ '.claude/hooks.json': '{ "hooks": { "command": "marbled-teapot-quorum" } }\n' });
    const said = JSON.stringify((await ask(folder)).body);
    expect(said).toContain('.claude/hooks.json');
    expect(said).not.toContain('marbled-teapot');
  });

  it('shows every warning group when a folder configures several tools', async () => {
    const folder = plant({
      '.claude/settings.json': '{ "permissions": { "defaultMode": "bypassPermissions" }, "hooks": {} }\n',
      '.mcp.json': '{ "mcpServers": { "demo": { "command": "./demo.sh" } } }\n',
      '.envrc': 'echo demo\n',
      'paseo.json': '{ "scripts": { "setup": "./prepare.sh" } }\n',
      '.vscode/tasks.json': '{ "tasks": [{ "command": "echo demo", "runOn": "folderOpen" }] }\n',
    });
    const { status, body } = await ask(folder);
    expect(status).toBe(200);
    const notices = (body as { notices: { text: string; files: string[] }[] }).notices;
    expect(notices).toHaveLength(6);
    expect(notices.map((notice) => notice.text)).toContain('This folder has hooks Claude Code runs without asking.');
    expect(notices.flatMap((notice) => notice.files)).toContain('.vscode/tasks.json');
  });

  it('lists four files and counts the rest', async () => {
    const folder = plant(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`.claude/hooks/step-${n}.sh`, 'echo hi\n'])));
    const notices = (await ask(folder)).body as { notices: { files: string[] }[] };
    expect(notices.notices).toHaveLength(1);
    expect(notices.notices[0]!.files.at(-1)).toBe('+2 more');
  });

  it('holds to the check it was given, so a test folder needs no fixture of its own', async () => {
    const seen: string[] = [];
    const scan: ProjectConfigScanner = (folder) => {
      seen.push(folder);
      return { findings: [finding('secrets/agent.json', 'grants-permissions', ['claude', 'copilot'])], errors: [] };
    };
    expect(await ask('/somewhere/agent/will/work', 'claude', scan)).toEqual({
      status: 200,
      body: { notices: [{ text: 'Files here can give Claude Code permission to act without asking.', files: ['secrets/agent.json'] }] },
    });
    expect(seen).toEqual(['/somewhere/agent/will/work']);
  });

  it('speaks for any tool when it does not know the agent chosen', () => {
    expect(projectConfigNotices([finding('.cursor/hooks.json', 'runs-hooks', ['copilot', 'cursor'])], 'amp')).toEqual([
      { text: 'This folder has hooks GitHub Copilot or Cursor runs without asking.', files: ['.cursor/hooks.json'] },
    ]);
  });

  it('says when the folder could not be read, rather than looking clean', async () => {
    const scan: ProjectConfigScanner = () => {
      throw new Error('The configuration directory could not be scanned.');
    };
    expect(await ask('/somewhere/unreadable', 'claude', scan)).toEqual({ status: 200, body: { notices: [], unreadable: true } });
    expect(JSON.stringify(await ask('/somewhere/unreadable', 'claude', scan))).not.toContain('could not be scanned');
  });

  it('keeps what it did find when part of the folder changed under it', async () => {
    const scan: ProjectConfigScanner = () => ({
      findings: [finding('paseo.json', 'runs-code', ['paseo'])],
      errors: [{ path: '.', reason: 'changed during the scan' }],
    });
    expect(await ask('/somewhere/changing', 'claude', scan)).toEqual({
      status: 200,
      body: {
        notices: [{ text: 'This folder has code Paseo runs on its own.', files: ['paseo.json'] }],
        unreadable: true,
      },
    });
  });

  it.each([
    ['a folder that is not an absolute path', { path: 'relative/here', provider: 'claude' }],
    ['an agent name the sheet would never send', { path: '/home/me/app', provider: 'Claude Code' }],
    ['no folder at all', { provider: 'claude' }],
    ['something else as well', { path: '/home/me/app', provider: 'claude', extra: true }],
  ])('refuses %s', async (_label, body) => {
    const ctx = await makeApp(keys);
    apps.push(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/project-config',
      headers: postHeaders(token),
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(400);
  });
});
