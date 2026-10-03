import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', ...(process.env.WAYROOST_TEST_PORTS ? { fileParallelism: false, setupFiles: ['../tests/development-ports.ts'] } : {}) } });
