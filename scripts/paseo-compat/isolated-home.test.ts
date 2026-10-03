// The compat checks' home isolation: HOME moves under the temp root, and a change in the
// watched skill folders of the home it left fails the check. The "real" home here is a
// temp folder too.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateHome } from './isolated-home.js';

let savedEnv: NodeJS.ProcessEnv;
let scratch: string;
let realHome: string;
let root: string;
const skill = () => join(realHome, '.agents', 'skills', 'example', 'SKILL.md');
const inheritedGit = () => Object.keys(process.env).filter((key) => key.startsWith('GIT_'));

/**
 * The environment for the git this file runs itself (setup and the unisolated control): every
 * Git variable the run inherited goes (a GIT_TRACE* target or GIT_DIR of yours would be written
 * to or initialised), the system config is an empty file of the fixture's, and only the
 * variables in `fixture`, which all point into the temp folders, come back.
 */
function fixtureGitEnv(fixture: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: realHome };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const emptyConfig = join(scratch, 'gitconfig-empty');
  writeFileSync(emptyConfig, '');
  return { ...env, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig, ...fixture };
}

/** A repository in the temp root, made by a git that sees none of the inherited Git variables. */
function initFixtureRepo(): string {
  const repo = join(root, 'workspace');
  mkdirSync(repo);
  const init = spawnSync('git', ['init', '-q', repo], { env: fixtureGitEnv(), encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  return repo;
}

beforeEach(() => {
  // The whole environment: isolateHome keeps only an allowlist of it. Each test starts
  // without the inherited Git variables, and the run's own come back afterwards.
  savedEnv = { ...process.env };
  for (const key of inheritedGit()) delete process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'sb-isolated-home-'));
  realHome = join(scratch, 'real');
  root = join(scratch, 'root');
  mkdirSync(join(realHome, '.agents', 'skills', 'example'), { recursive: true });
  mkdirSync(root);
  writeFileSync(skill(), 'example\n');
  process.env.HOME = realHome;
  process.env.CODEX_HOME = join(realHome, '.codex');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe('isolateHome', () => {
  it('moves HOME, USERPROFILE and the XDG folders under the temp root', () => {
    isolateHome(root);
    const home = join(root, 'home');
    expect(homedir()).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
    expect(process.env.XDG_CONFIG_HOME).toBe(join(home, '.config'));
    expect(process.env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'));
    expect(process.env.CODEX_HOME).toBeUndefined();
  });

  it("drops the files and folders Paseo's debug output would go to, which ignore HOME", () => {
    // Paseo appends every git command to PASEO_GIT_TRACE_FILE, an absolute path, and the
    // speech debug folders are absolute too: set, they would reach the real home.
    process.env.PASEO_GIT_TRACE_FILE = join(realHome, 'git-trace.jsonl');
    process.env.TTS_DEBUG_AUDIO_DIR = join(realHome, 'tts');
    process.env.STT_DEBUG_AUDIO_DIR = join(realHome, 'stt');
    process.env.DICTATION_DEBUG_AUDIO_DIR = join(realHome, 'dictation');
    process.env.PASEO_DICTATION_DEBUG = '1';
    isolateHome(root);
    for (const name of ['PASEO_GIT_TRACE_FILE', 'TTS_DEBUG_AUDIO_DIR', 'STT_DEBUG_AUDIO_DIR', 'DICTATION_DEBUG_AUDIO_DIR', 'PASEO_DICTATION_DEBUG']) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it("drops Git's own trace targets, switches trace2 off, and drops the Git pointers to your repository and config", () => {
    process.env.GIT_TRACE = join(realHome, 'git-trace.log');
    process.env.GIT_TRACE_PACKET = join(realHome, 'git-packet.log');
    process.env.GIT_TRACE2_EVENT = join(realHome, 'git-trace2.json');
    process.env.GIT_DIR = join(realHome, 'repo', '.git');
    process.env.GIT_WORK_TREE = join(realHome, 'repo');
    process.env.GIT_CONFIG_GLOBAL = join(realHome, '.gitconfig');
    isolateHome(root);
    for (const name of ['GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_DIR', 'GIT_WORK_TREE']) {
      expect(process.env[name], name).toBeUndefined();
    }
    // The global config is one of the temp home's own, and the system config is skipped.
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(join(root, 'home', '.gitconfig'));
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    for (const name of ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF']) expect(process.env[name], name).toBe('0');
  });

  it("keeps the git Paseo starts from writing its trace into the home it left", () => {
    // Paseo runs git with process.env as it finds it (plus an overlay of its own), so an
    // inherited trace target, or one named in the system git config, would be appended to.
    const repo = initFixtureRepo();
    const targets = {
      trace: join(realHome, 'git-trace.log'),
      event: join(realHome, 'git-trace2.json'),
      fromConfig: join(realHome, 'git-trace2-config.json'),
    };
    const systemConfig = join(scratch, 'gitconfig-system');
    writeFileSync(systemConfig, `[trace2]\n\tperfTarget = ${targets.fromConfig}\n`);
    process.env.GIT_CONFIG_SYSTEM = systemConfig;
    process.env.GIT_TRACE = targets.trace;
    process.env.GIT_TRACE2_EVENT = targets.event;
    process.env.GIT_DIR = join(realHome, 'not-a-repo', '.git');
    // Without isolation, this git writes all three (the probe isn't vacuous). It gets the
    // fixture's targets and config only, not the rest of the run's environment.
    spawnSync('git', ['status'], { cwd: repo, env: fixtureGitEnv({ GIT_CONFIG_SYSTEM: systemConfig, GIT_TRACE: targets.trace, GIT_TRACE2_EVENT: targets.event }) });
    for (const target of Object.values(targets)) {
      expect(existsSync(target), target).toBe(true);
      rmSync(target);
    }
    const untouched = isolateHome(root);
    const probe = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, env: process.env, encoding: 'utf8' });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe(join(repo, '.git'));
    for (const target of Object.values(targets)) expect(existsSync(target), target).toBe(false);
    expect(untouched()).toBe(true);
  });

  it("keeps the inherited Git variables away from this file's own git setup and control", () => {
    // As inside a git hook, or with tracing on in your shell: the targets are in the "real" home.
    const inherited = {
      GIT_TRACE: join(realHome, 'inherited-trace.log'),
      GIT_TRACE_PERFORMANCE: join(realHome, 'inherited-perf.log'),
      GIT_TRACE2_EVENT: join(realHome, 'inherited-trace2.json'),
      GIT_DIR: join(realHome, 'inherited-repo', '.git'),
      GIT_CONFIG_GLOBAL: join(realHome, 'inherited-gitconfig'),
    };
    Object.assign(process.env, inherited);
    const repo = initFixtureRepo();
    expect(existsSync(join(repo, '.git', 'HEAD'))).toBe(true);
    const control = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo, env: fixtureGitEnv(), encoding: 'utf8' });
    expect(control.stdout.trim()).toBe(join(repo, '.git'));
    for (const target of Object.values(inherited)) expect(existsSync(target), target).toBe(false);
  });

  it('drops the other pointers to your own provider folders, and moves the Windows app-data folders', () => {
    process.env.CLAUDE_HOME = join(realHome, '.claude');
    process.env.KIMI_CODE_HOME = join(realHome, '.kimi-code');
    process.env.APPDATA = join(realHome, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = join(realHome, 'AppData', 'Local');
    isolateHome(root);
    const home = join(root, 'home');
    expect(process.env.CLAUDE_HOME).toBeUndefined();
    expect(process.env.KIMI_CODE_HOME).toBeUndefined();
    expect(process.env.APPDATA).toBe(join(home, 'AppData', 'Roaming'));
    expect(process.env.LOCALAPPDATA).toBe(join(home, 'AppData', 'Local'));
  });

  it('passes when nothing changed in the watched folders of the home it left', () => {
    expect(isolateHome(root)()).toBe(true);
  });

  it('fails when a skill appears there', () => {
    const untouched = isolateHome(root);
    mkdirSync(join(realHome, '.claude', 'skills', 'paseo'), { recursive: true });
    expect(untouched()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('~/.claude/skills'));
  });

  it('fails when a skill file there is rewritten, going by its modification time', () => {
    const untouched = isolateHome(root);
    utimesSync(skill(), new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(untouched()).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('~/.agents/skills/example/SKILL.md'));
  });

  it('ignores changes in the temp home', () => {
    const untouched = isolateHome(root);
    mkdirSync(join(homedir(), '.codex', 'skills', 'paseo'), { recursive: true });
    expect(untouched()).toBe(true);
  });
});
