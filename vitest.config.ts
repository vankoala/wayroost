import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'web/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
