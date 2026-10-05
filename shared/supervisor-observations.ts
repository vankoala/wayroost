import { z } from 'zod';
import { absolutePathSchema } from './settings-targets.js';
import { settingsErrorCodeSchema } from './settings.js';

const refusal = z.object({ ok: z.literal(false), code: settingsErrorCodeSchema }).strict();
const relativePath = z.string().max(4096).refine(path => !path.startsWith('/') && !path.split('/').includes('..'));
const owner = z.enum(['claude', 'codex', 'opencode', 'pi', 'copilot', 'gemini', 'hermes', 'cursor', 'paseo', 'vscode', 'direnv']);
export const projectScanRequestSchema = z.object({ folder: absolutePathSchema,
  workspaceRoots: z.array(absolutePathSchema).max(128).default([]) }).strict();
export const projectScanResultSchema = z.union([
  z.object({ ok: z.literal(true), scan: z.object({ findings: z.array(z.object({ path: relativePath,
    kind: z.enum(['grants-permissions', 'runs-hooks', 'runs-code', 'instructions', 'unknown']),
    providers: z.array(owner).max(11), reason: z.string().max(200) }).strict()).max(1024),
  errors: z.array(z.object({ path: relativePath, reason: z.string().max(200) }).strict()).max(1024) }).strict() }).strict(), refusal,
]);
export const checksObserveRequestSchema = z.object({}).strict();
export const checksObserveResultSchema = z.union([
  z.object({ ok: z.literal(true), hermesStartedAt: z.number().int().nonnegative().nullable(),
    coderProcesses: z.array(z.object({ startedAt: z.number().int().nonnegative(), script: z.enum(['original', 'gateway-copy', 'other']) }).strict()).max(256).nullable(),
    drainMarker: z.object({ present: z.boolean(), ours: z.boolean(), requestedAt: z.number().nonnegative(), drainRunning: z.boolean().nullable(), unreadable: z.boolean() }).strict().nullable(),
    switchFlags: z.record(z.string().max(128), z.boolean()).nullable(),
  }).strict(), refusal,
]);
export type ProjectScanRequest = z.infer<typeof projectScanRequestSchema>;
export type ProjectScanResult = z.infer<typeof projectScanResultSchema>;
export type ChecksObserveResult = z.infer<typeof checksObserveResultSchema>;
