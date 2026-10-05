import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checksObserveResultSchema, projectScanRequestSchema, projectScanResultSchema } from '../../shared/supervisor-observations.js';
import { settingsTargetsSchema } from '../../shared/settings-targets.js';
import { coderProcesses, drainMarker, hermesStartedAt, switchFlags } from '../../server/src/checks/sources.js';
import { scanFolderProjectConfig } from '../../server/src/hub/project-config-notice.js';
import { checkConfigDirectory, ConfigError } from './config-paths.js';
import { configUnit, type ConfigUnit } from './config-unit.js';
import { DRAIN_UNIT } from './drain-files.js';

export const observationEntry = fileURLToPath(new URL('./observation-entry.js', import.meta.url));
export const observationRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('project-scan'), request: projectScanRequestSchema, uid: z.number().int().positive() }).strict(),
  z.object({ mode: z.literal('checks-observe'), site: settingsTargetsSchema, uid: z.number().int().positive(), kind: z.enum(['hermes', 'coder', 'flags']) }).strict(),
]);
export async function projectScanUnit(input: unknown, executable = process.execPath, entry = observationEntry): Promise<ConfigUnit> {
  const request = projectScanRequestSchema.parse(input);
  const folder = await lstat(request.folder);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid === 0) throw new ConfigError('unsafe_target');
  await checkConfigDirectory(request.folder, folder.uid, true);
  request.workspaceRoots = request.workspaceRoots.filter(root => {
    const child = relative(root, request.folder);
    return !isAbsolute(child) && !/^\.\.(?:[/\\]|$)/.test(child);
  }).sort((a, b) => b.length - a.length).slice(0, 1);
  for (const root of request.workspaceRoots) await checkConfigDirectory(root, folder.uid, true);
  return configUnit({ path: request.folder, uid: folder.uid }, { mode: 'project-scan', request, uid: folder.uid }, executable, entry);
}
export async function executeObservation(input: unknown, uid = process.getuid!()) {
  const request = observationRequestSchema.parse(input);
  if (uid === 0 || uid !== request.uid) throw new ConfigError('unsafe_target');
  if (request.mode === 'project-scan') {
    const folder = await lstat(request.request.folder);
    if (folder.uid !== uid || !folder.isDirectory() || folder.isSymbolicLink()) throw new ConfigError('unsafe_target');
    await checkConfigDirectory(request.request.folder, uid, true);
    return projectScanResultSchema.parse({ ok: true, scan: scanFolderProjectConfig(request.request.folder, request.request.workspaceRoots) });
  }
  const site = request.site;
  const result = { ok: true as const, hermesStartedAt: null as number | null,
    coderProcesses: null as Awaited<ReturnType<typeof coderProcesses>> | null,
    drainMarker: null as Awaited<ReturnType<typeof drainMarker>> | null, switchFlags: null as Record<string, boolean> | null };
  if (request.kind === 'hermes' && site.hermes?.runAs.uid === uid && site.hermes.drainMarker.runAs.uid === uid) {
    result.hermesStartedAt = await hermesStartedAt(site.hermes.gatewayUnit, Date.now).catch(() => null);
    result.drainMarker = await drainMarker({ path: site.hermes.drainMarker.path,
      stateFile: join(site.hermes.drainStateDir, 'hermes-gateway.json'), executorUnit: DRAIN_UNIT }).catch(() => null);
  }
  if (request.kind === 'coder') result.coderProcesses = await coderProcesses(site.coderMcp, Date.now).catch(() => null);
  if (request.kind === 'flags' && site.switchFlags) {
    await checkConfigDirectory(site.switchFlags.path, uid);
    result.switchFlags = await switchFlags(site.switchFlags.path).catch(() => null);
  }
  return checksObserveResultSchema.parse(result);
}
