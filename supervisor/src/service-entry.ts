import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { credentialWriteResultSchema } from '../../shared/supervisor-config.js';
import { readConfigInput } from './config-entry.js';
import { executeCredential, prepareCredentialStorage, readImportKey } from './credential-executor.js';
import { fileDrainIO, prepareDrainStorage } from './drain-files.js';
import { cleanupDrain, drainProgressSchema, executeHermesDrain, sweepDrain } from './drain-runtime.js';
import type { DrainRestartRun } from '../../shared/supervisor-config.js';
import { executeRecovery, recoveryRequestSchema } from './config-recovery.js';
import { executeComponentRestart } from './component-restart.js';

const hermesSchema = settingsTargetsSchema.shape.hermes.unwrap();
const requestSchema = z.discriminatedUnion('mode', [
  recoveryRequestSchema,
  z.object({ mode: z.literal('component-restart'), site: settingsTargetsSchema, component: z.enum(['gateway', 'dashboard']), when: z.enum(['idle', 'now']) }).strict(),
  z.object({ mode: z.literal('credential'), site: settingsTargetsSchema, request: z.unknown() }).strict(),
  z.object({ mode: z.literal('prepare-credential'), site: settingsTargetsSchema }).strict(),
  z.object({ mode: z.literal('import-read'), site: settingsTargetsSchema, provider: z.string() }).strict(),
  z.object({ mode: z.literal('drain'), target: hermesSchema, when: z.enum(['idle', 'now']) }).strict(),
  z.object({ mode: z.literal('sweep'), target: hermesSchema }).strict(),
  z.object({ mode: z.literal('prepare-drain'), target: hermesSchema }).strict(),
]);
export async function executeService(input: unknown, update: (patch: Partial<DrainRestartRun>) => void = () => {}, drainIO = fileDrainIO): Promise<unknown> {
  const request = requestSchema.parse(input);
  if (request.mode === 'recovery') return executeRecovery(request, { drainIO });
  if (request.mode === 'component-restart') return executeComponentRestart(request.site, request.component, request.when, update);
  if (request.mode === 'credential') return credentialWriteResultSchema.parse(await executeCredential(request.site, request.request));
  if (request.mode === 'prepare-credential') { await prepareCredentialStorage(request.site); return { ok: true }; }
  if (request.mode === 'import-read') return { secret: await readImportKey(request.site, request.provider) };
  if (request.mode === 'prepare-drain') { await prepareDrainStorage(request.target); return { ok: true }; }
  const io = drainIO(request.target);
  if (request.mode === 'sweep') { await sweepDrain(io); return { ok: true }; }
  return executeHermesDrain(io, request.when, update);
}
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  const emit = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    if (process.argv[2] === 'cleanup') await cleanupDrain(fileDrainIO(hermesSchema.parse(JSON.parse(process.argv[3]!))));
    else emit(JSON.stringify(await executeService(JSON.parse(await readConfigInput(process.stdin)),
      patch => emit(JSON.stringify(drainProgressSchema.parse({ progress: patch })) + '\n'))) + '\n');
  } catch {
    if (process.argv[2] !== 'cleanup') emit('{"ok":false,"code":"failed"}\n');
    process.exitCode = 1;
  }
}
