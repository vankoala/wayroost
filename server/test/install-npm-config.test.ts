import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('installer npm configuration', () => {
  it.each(['supervisor', 'server'])('loads distinct config paths for the %s destination', kind => {
    mkdirSync('.tmp', { recursive: true });
    const folder = mkdtempSync(join(process.cwd(), '.tmp', 'install-npm-'));
    folders.push(folder);
    const root = join(folder, 'root');
    const destination = join(root, 'opt', 'wayroost', kind);
    const installer = kind === 'supervisor' ? 'deploy/install-supervisor.sh' : 'deploy/install-wayroost-server.sh';
    const plan = execFileSync('bash', [installer, '--dry-run', '--root', root], { encoding: 'utf8' });
    const line = plan.split('\n').find(item => item.includes('NPM_CONFIG_USERCONFIG='));
    expect(line).toBeDefined();
    expect(line).toContain('NPM_CONFIG_USERCONFIG=/dev/null');
    expect(line).toContain(`NPM_CONFIG_GLOBALCONFIG=${destination}/.npm-no-globalconfig`);
    expect(line).toContain('--ignore-scripts');

    const variables = Object.fromEntries([...line!.matchAll(/(NPM_CONFIG_[A-Z]+)=([^ ]+)/g)].map(match => [match[1]!, match[2]!]));
    expect(variables.NPM_CONFIG_GLOBALCONFIG).toBe(join(destination, '.npm-no-globalconfig'));
    expect(variables.NPM_CONFIG_USERCONFIG).not.toBe(variables.NPM_CONFIG_GLOBALCONFIG);
    expect(existsSync(variables.NPM_CONFIG_GLOBALCONFIG!)).toBe(false);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'package.json'), '{"name":"demo-install-config","version":"1.0.0"}\n');
    writeFileSync(join(destination, '.npmrc'), 'ignore-scripts=true\n');
    // npm forwards lowercase config variables to scripts; isolate the planned environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const config = (key: string) => execFileSync('npm', ['config', 'get', key, '--prefix', destination], {
      cwd: destination, env: { ...env, ...variables }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    expect(config('userconfig')).toBe('/dev/null');
    expect(config('globalconfig')).toBe(join(destination, '.npm-no-globalconfig'));
    expect(config('ignore-scripts')).toBe('true');
  });
});
