import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Desktop tests that need the desktop package's own dependencies (desktop/node_modules), which the root
 * install doesn't have. The Windows desktop CI job runs them after `npm ci` in desktop/.
 */
export const desktopOnly = ['desktop/test/fuses.test.ts', 'desktop/test/main.test.ts', 'desktop/test/tray.test.ts'];

const base = { environment: 'node', testTimeout: 15_000 } as const;
/** The app's tests, the desktop's that the root install can run included (scripts/root-suite.test.ts checks). */
export const appTests = {
  include: ['server/test/**/*.test.ts', 'web/src/**/*.test.ts', 'scripts/**/*.test.ts', 'desktop/test/**/*.test.ts', 'gateway/test/**/*.test.ts'],
  exclude: [...configDefaults.exclude, ...desktopOnly],
};
const supervisor = ['supervisor/test/**/*.test.ts'];

export default defineConfig({
  test: process.env.WAYROOST_TEST_PORTS
    // Isolated checkouts with assigned ports: every file runs alone, on those ports.
    ? {
        ...base,
        include: [...supervisor, ...appTests.include],
        exclude: appTests.exclude,
        fileParallelism: false,
        setupFiles: ['tests/development-ports.ts'],
      }
    : {
        projects: [
          { test: { ...base, name: 'app', ...appTests } },
          // The supervisor tests listen on fixed development ports (8898, 8899), so
          // their files take turns instead of racing for them.
          { test: { ...base, name: 'supervisor', include: supervisor, fileParallelism: false } },
        ],
      },
});
