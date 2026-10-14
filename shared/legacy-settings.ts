import { z } from 'zod';
import { isUtf8 } from 'node:buffer';
import { ProviderOverridesSchema } from '@getpaseo/protocol/provider-config';
import { PROACTIVITY_LEVELS, WORKER_TIME_BOXES, type WorkerUpdatesStatus } from './protocol.js';
import { CLOUD_ID, type AppVoice } from './voice.js';
import { DEFAULT_NOTIFICATION_RULES, DEFAULT_QUIET_HOURS, settingsNotificationsBodySchema } from './settings.js';

export type LegacyProblem = 'empty' | 'malformed' | 'bom' | 'wrong_type' | 'invalid_value';
export interface LegacyRead<T> {
  document: Record<string, unknown>;
  value: T;
  problems: LegacyProblem[];
}

/** The legacy stores use replacement UTF-8 decoding and last-key-wins JSON. */
export function parseLegacyJson(source: string): unknown { return JSON.parse(source); }

export function legacyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function preference(source: string | null): { document: Record<string, unknown>; problems: LegacyProblem[] } {
  if (source === null) return { document: {}, problems: [] };
  try {
    const raw = parseLegacyJson(source);
    return { document: legacyObject(raw), problems: raw && typeof raw === 'object' && !Array.isArray(raw) ? [] : ['wrong_type'] };
  } catch {
    return { document: {}, problems: [source.startsWith('\uFEFF') ? 'bom' : source.trim() === '' ? 'empty' : 'malformed'] };
  }
}

export const DEFAULT_TIME_BOX_MINUTES = 60;
export function readLegacyWorkerUpdates(source: string | null): LegacyRead<Omit<WorkerUpdatesStatus, 'timeBoxes'>> {
  const parsed = preference(source);
  if (Object.hasOwn(parsed.document, 'enabled') && typeof parsed.document.enabled !== 'boolean') parsed.problems.push('invalid_value');
  let minutes: number;
  try { minutes = Number(parsed.document.defaultMinutes); }
  catch { return { ...parsed, problems: [...parsed.problems, 'invalid_value'], value: { enabled: true, defaultMinutes: DEFAULT_TIME_BOX_MINUTES } }; }
  const valid = (WORKER_TIME_BOXES as readonly number[]).includes(minutes);
  if (Object.hasOwn(parsed.document, 'defaultMinutes') && !valid) parsed.problems.push('invalid_value');
  return { ...parsed, value: { enabled: parsed.document.enabled !== false, defaultMinutes: valid ? minutes : DEFAULT_TIME_BOX_MINUTES } };
}

export function readLegacySafetyCommands(source: string | null): LegacyRead<boolean> {
  const parsed = preference(source);
  if (Object.hasOwn(parsed.document, 'enabled') && typeof parsed.document.enabled !== 'boolean') parsed.problems.push('invalid_value');
  return { ...parsed, value: parsed.document.enabled === true };
}

export const VOICE_NAME = /^[a-z]{2}_[a-z]{2,20}$/;
export function readLegacyVoice(source: string | null): LegacyRead<{ voice: string; appReadAloud: AppVoice }> {
  const parsed = preference(source);
  const voice = parsed.document.voice;
  const app = legacyObject(parsed.document.appReadAloud);
  const validVoice = typeof voice === 'string' && VOICE_NAME.test(voice);
  const validApp = app.provider === 'elevenlabs' && typeof app.voiceId === 'string' && CLOUD_ID.test(app.voiceId)
    && typeof app.modelId === 'string' && CLOUD_ID.test(app.modelId);
  if (Object.hasOwn(parsed.document, 'voice') && !validVoice && voice !== '') parsed.problems.push('invalid_value');
  if (Object.hasOwn(parsed.document, 'appReadAloud') && !validApp && app.provider !== 'local') parsed.problems.push('invalid_value');
  return { ...parsed, value: { voice: validVoice ? voice : '', appReadAloud: validApp
    ? { provider: 'elevenlabs', voiceId: app.voiceId as string, modelId: app.modelId as string } : { provider: 'local' } } };
}

export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
export const DEFAULT_FEED_SETTINGS = {
  level: 'normal' as const,
  quietHours: { start: '21:00', end: '07:00' },
  push: { approvals: true, cards: false },
  lessLike: [] as Array<{ topic: string; example: string; at: number }>,
};
export const legacyFeedSchema = z.object({
  level: z.enum(PROACTIVITY_LEVELS).catch('normal'),
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable().catch(DEFAULT_FEED_SETTINGS.quietHours),
  push: z.object({ approvals: z.boolean(), cards: z.boolean() }).catch(DEFAULT_FEED_SETTINGS.push),
  lessLike: z.array(z.object({ topic: z.string(), example: z.string(), at: z.number() })).catch([]),
});
export function readLegacyFeed(source: string | null): LegacyRead<z.infer<typeof legacyFeedSchema>> {
  const parsed = preference(source);
  if (source === null || parsed.problems.some(problem => ['empty', 'malformed', 'bom'].includes(problem)) || source.trim() === 'null') {
    return { ...parsed, value: { ...DEFAULT_FEED_SETTINGS, lessLike: [] } };
  }
  const raw = parsed.document.settings ?? {};
  const settings = legacyFeedSchema.safeParse(raw);
  if (!settings.success) parsed.problems.push('wrong_type');
  else for (const [key, field] of Object.entries(legacyFeedSchema.shape)) {
    if (Object.hasOwn(legacyObject(raw), key) && !field.unwrap().safeParse(legacyObject(raw)[key]).success) parsed.problems.push('invalid_value');
  }
  return { ...parsed, value: settings.success ? settings.data : { ...DEFAULT_FEED_SETTINGS } };
}

export const LEGACY_NOTIFICATION_MAX_BYTES = 128 * 1024;
export const LEGACY_NOTIFICATION_FORBIDDEN_MODE = 0o7027;
export function decodeLegacyNotifications(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw new Error('Invalid UTF-8.');
  return bytes.toString('utf8');
}

/** Invalid notification documents are refused by the checked settings reader. */
export function readLegacyNotifications(source: string) {
  const parsed = parseLegacyJson(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings document.');
  const { safetyCommandsEnabled, ...notifications } = parsed as Record<string, unknown>;
  if (safetyCommandsEnabled !== undefined) z.boolean().parse(safetyCommandsEnabled);
  const body = settingsNotificationsBodySchema.parse({ rules: DEFAULT_NOTIFICATION_RULES.map(rule => ({ ...rule })),
    quietHours: { ...DEFAULT_QUIET_HOURS }, push: { approvals: true, cards: false }, ...notifications });
  return { document: parsed as Record<string, unknown>, value: { rules: body.rules, quietHours: body.quietHours, push: body.push } };
}

export const legacyToolsSchema = z.object({ enabled: z.boolean().optional(), disabledTools: z.array(z.string()).optional() }).passthrough();
const Entry = z.object({ paseoTools: legacyToolsSchema.optional() }).passthrough();
const ProviderId = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const legacyProvidersSchema = z.record(ProviderId, Entry);
export const legacyApprovalBackupSchema = z.record(ProviderId, z.object({ entry: z.enum(['existing', 'added']),
  before: legacyToolsSchema.optional(), applied: legacyToolsSchema }).strict());
const Prepared = z.object({ beforeRevision: z.string(), afterRevision: z.string(), previousBackup: legacyApprovalBackupSchema,
  committedBackup: legacyApprovalBackupSchema }).strict();
export const legacyApprovalStateSchema = z.object({ version: z.literal(1), enabled: z.boolean(), backup: legacyApprovalBackupSchema,
  reloadPending: z.boolean(), prepared: Prepared.optional() }).strict();
export const legacyPaseoSchema = z.object({ agents: z.object({ providers: legacyProvidersSchema.optional() }).passthrough().optional() }).passthrough();
export const LEGACY_PASEO_MAX_BYTES = 2 * 1024 * 1024;
export const LEGACY_APPROVAL_MAX_BYTES = 16 * 1024 * 1024;
export function readLegacyApprovalState(source: string | null) {
  return source === null ? { version: 1 as const, enabled: true, backup: {}, reloadPending: true }
    : legacyApprovalStateSchema.parse(parseLegacyJson(source));
}
export function readLegacyPaseo(source: string) { return legacyPaseoSchema.parse(parseLegacyJson(source)); }

/** Unsupported provider definitions stay uncovered and are not rewritten by policy operations. */
export function editableLegacyProviders(current: z.infer<typeof legacyProvidersSchema>) {
  return Object.fromEntries(Object.entries(current).filter(([id, entry]) => ProviderOverridesSchema.safeParse({ [id]: entry }).success));
}
