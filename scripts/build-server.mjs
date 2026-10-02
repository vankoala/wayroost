// Bundles the server into dist/server/index.js; npm packages stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
});
