// Bundles the server into dist/server/index.js, and the recovery tool
// (scripts/pair-code.ts) into dist/server/pair-code.js; npm packages stay external.
import { build } from 'esbuild';

await build({
  entryPoints: { index: 'server/src/index.ts', 'pair-code': 'scripts/pair-code.ts', 'tls-certificates': 'scripts/tls-certificates.ts', 'safety-helper': 'server/src/paseo/safety-helper.ts', 'voice-cloud': 'speech/wayroost-voice-cloud.ts' },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
});
