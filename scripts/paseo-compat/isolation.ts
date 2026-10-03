import { join } from 'node:path';

/** The temporary home inside a compat check's root: HOME, USERPROFILE and the XDG folders. */
export function isolatedHome(root: string): string {
  return join(root, 'home');
}

/**
 * Trace2 targets can also come from the system git config (trace2.eventTarget and the like),
 * which HOME doesn't move; these variables override it, and "0" switches each one off.
 */
const GIT_TRACE2_OFF = ['GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF'];

export function isolatedDaemonEnv(root: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // An allowlist also removes provider config, trace outputs, shell startup hooks
  // and credentials added by future versions. Only fake ACP agents run here.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PASEO_LOG', 'PASEO_DEBUG']) {
    if (inherited[key] !== undefined) env[key] = inherited[key];
  }
  const home = isolatedHome(root);
  // Windows only: where USERPROFILE goes, these go with it.
  if (inherited.APPDATA !== undefined) env.APPDATA = join(home, 'AppData', 'Roaming');
  if (inherited.LOCALAPPDATA !== undefined) env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    PASEO_HOME: join(root, '.paseo'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CONFIG_DIRS: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_DATA_DIRS: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    ...Object.fromEntries(GIT_TRACE2_OFF.map((key) => [key, '0'])),
  };
}

export function isolateDaemonEnv(root: string): void {
  const env = isolatedDaemonEnv(root, process.env);
  // Native APIs and child processes read the original environment object.
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
}

export async function startCompatDaemon<T>(start: (listen: string) => Promise<T>): Promise<T> {
  try {
    return await start('127.0.0.1:8892');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return start('127.0.0.1:8893');
  }
}

export function compatProviders(builtinIds: readonly string[], executable: string, fakeAgent: string) {
  return {
    ...Object.fromEntries(builtinIds.map((id) => [id, { enabled: false }])),
    fakeacp: { extends: 'acp', label: 'Fake ACP', command: [executable, fakeAgent] },
    fakemodes: { extends: 'acp', label: 'Fake ACP with modes', command: [executable, fakeAgent, '--modes'] },
    hermes: { extends: 'acp', label: 'Hermes', command: [executable, fakeAgent] },
  };
}
