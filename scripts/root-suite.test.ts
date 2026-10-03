import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Loaded by URL so the root typecheck doesn't take in vite's DOM typings, which retype the server's fetch bodies.
const configUrl = new URL('../vitest.config.ts', import.meta.url).href;
// The app project's include and exclude: the root suite runs the supervisor's tests as a project of their own.
const { appTests } = await import(configUrl) as { appTests: { include: string[]; exclude: string[] } };
const { include, exclude } = appTests;

/** The files under dir that the root suite collects, as repo-relative paths. */
function collected(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => `${dir}/${file.replaceAll('\\', '/')}`)
    .filter((file) => include.some((glob) => matchesGlob(file, glob)) && !exclude.some((glob) => matchesGlob(file, glob)));
}
/** Packages a file loads at run time (type-only imports are erased), following its relative imports. */
function runtimePackages(file: string, seen = new Set<string>()): Set<string> {
  const packages = new Set<string>();
  if (seen.has(file)) return packages;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const specifiers = [
    ...[...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]!),
    ...[...source.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
  ];
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      const local = [target, target.replace(/\.js$/, '.ts')].find((path) => existsSync(path));
      if (local) for (const name of runtimePackages(local, seen)) packages.add(name);
    } else if (!specifier.startsWith('node:') && !builtinModules.includes(specifier)) {
      packages.add(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
    }
  }
  return packages;
}

describe('root test suite', () => {
  it('ignores node_modules as a file, symlink or directory in every package', () => {
    const paths = ['node_modules', 'desktop/node_modules', 'desktop/node_modules/', 'demo-fixture/node_modules', 'demo-fixture/node_modules/package.json'];
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: paths.join('\n') + '\n', encoding: 'utf8' });
    expect(ignored.trim().split('\n')).toEqual(paths);
  });

  it('installs both packages before Windows desktop tests that also load web modules', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const desktop = workflow.split(/^  desktop:\s*$/m)[1]?.split(/^  \S/m)[0] ?? '';
    expect(desktop).toMatch(/defaults:\s+run:\s+working-directory: desktop/);
    const steps = desktop.split(/^      - /m).map((step) => ({
      run: step.match(/^(?:        )?run: (.+)$/m)?.[1],
      directory: step.match(/^        working-directory: (.+)$/m)?.[1] ?? 'desktop',
    }));
    const tests = steps.findIndex((step) => step.run === 'npm test' && step.directory === 'desktop');
    expect(tests).toBeGreaterThanOrEqual(0);
    for (const directory of ['.', 'desktop']) {
      const install = steps.findIndex((step) => step.directory === directory && /^npm ci(?:\s|$)/.test(step.run ?? ''));
      expect(install, `Install ${directory} dependencies before desktop tests`).toBeGreaterThanOrEqual(0);
      expect(install).toBeLessThan(tests);
    }
  });

  it('keeps checkout dependencies ignored and never symlinks desktop dependencies', () => {
    // Without the trailing slash, so a node_modules file or symlink is ignored as well as a folder.
    expect(readFileSync(join(root, '.gitignore'), 'utf8').split('\n')).toContain('node_modules');
    expect(lstatSync(join(root, 'desktop/node_modules'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false).toBe(false);
  });
  it('collects only desktop tests that the root install can run', () => {
    // CI's root job installs the root package only; desktop/node_modules exists only in the desktop job.
    const tests = collected('desktop/test');
    expect(tests.length).toBeGreaterThan(0);
    const missing = tests.flatMap((test) => [...runtimePackages(join(root, test))]
      .filter((name) => !existsSync(join(root, 'node_modules', name, 'package.json')))
      .map((name) => `${test}: ${name}`));
    expect(missing).toEqual([]);
  });
  it('finds packages behind relative and CommonJS requires', () => {
    // The fuse check reaches @electron/fuses through desktop/scripts/check-fuses.cjs.
    const fuses = join(root, 'desktop/test/fuses.test.ts');
    expect([...runtimePackages(fuses)]).toContain('@electron/fuses');
    expect(collected('desktop/test')).not.toContain(relative(root, fuses).replaceAll('\\', '/'));
  });
});
