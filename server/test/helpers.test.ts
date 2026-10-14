import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { temporaryDirectory } from '../../tests/temporary-directory.js';

it('removes all helper state allocations when a test file finishes', () => {
  const root = temporaryDirectory('wayroost-helper-cleanup-');
  try {
    const customState = join(root, 'custom-state');
    mkdirSync(customState);
    writeFileSync(join(customState, 'demo.json'), '{}');
    const helper = fileURLToPath(new URL('./helpers.ts', import.meta.url));
    const allocator = fileURLToPath(new URL('../../tests/temporary-directory.ts', import.meta.url));
    const config = join(root, 'vitest.config.mjs');
    writeFileSync(config, "export default { test: { include: ['cleanup.test.ts'] } };\n");
    writeFileSync(join(root, 'cleanup.test.ts'), `
      import { expect, it, vi } from 'vitest';
      vi.mock(${JSON.stringify(allocator)}, async () => {
        const { mkdtempSync } = await import('node:fs');
        const { join } = await import('node:path');
        return { temporaryDirectory: prefix => mkdtempSync(join(${JSON.stringify(root)}, prefix)) };
      });
      import { makeConfig } from ${JSON.stringify(helper)};
      it('allocates state for valid, overridden and invalid configs', () => {
        makeConfig();
        makeConfig(undefined, { stateDir: ${JSON.stringify(customState)} });
        expect(() => makeConfig(undefined, { publicOrigin: 'invalid' })).toThrow();
      });
    `);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run', '--root', root, '--config', config,
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readdirSync(root).filter(name => name.startsWith('sb-state-'))).toEqual([]);
    expect(readFileSync(join(customState, 'demo.json'), 'utf8')).toBe('{}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
