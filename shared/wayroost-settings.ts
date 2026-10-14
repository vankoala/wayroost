import { z } from 'zod';
import { PROACTIVITY_LEVELS, WORKER_TIME_BOXES } from './protocol.js';
import { CLOUD_ID } from './voice.js';
import { notificationQuietHoursSchema, notificationRulesSchema } from './settings.js';

export const localVoiceSchema = z.string().regex(/^(?:[a-z]{2}_[a-z]{2,20})?$/);
export const appReadAloudSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('local') }).strict(),
  z.object({ provider: z.literal('elevenlabs'), voiceId: z.string().regex(CLOUD_ID), modelId: z.string().regex(CLOUD_ID) }).strict(),
]);
export const workerUpdatesSchema = z.object({
  enabled: z.boolean().optional(),
  defaultMinutes: z.number().int().refine(value => (WORKER_TIME_BOXES as readonly number[]).includes(value)).optional(),
}).strict();
export const voiceSettingsSchema = z.object({ voice: localVoiceSchema.optional(), appReadAloud: appReadAloudSchema.optional() }).strict();
export const feedPreferencesSchema = z.object({
  level: z.enum(PROACTIVITY_LEVELS).optional(),
  lessLike: z.array(z.object({ topic: z.string().min(1).max(40), example: z.string().max(100), at: z.number().int().nonnegative() }).strict()).max(30).optional(),
}).strict();
export const notificationTimeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});

/** Owner-held settings only. No defaults/transforms: parsing preserves deliberate absence. */
export const wayroostSettingsSchema = z.object({
  version: z.literal(1),
  safetyCommandsEnabled: z.boolean().optional(),
  rules: notificationRulesSchema.optional(),
  quietHours: notificationQuietHoursSchema.nullable().optional(),
  push: z.object({ approvals: z.boolean().optional(), cards: z.boolean().optional() }).strict().optional(),
  timeZone: notificationTimeZoneSchema.optional(),
  feed: feedPreferencesSchema.optional(),
  workerUpdates: workerUpdatesSchema.optional(),
  voice: voiceSettingsSchema.optional(),
}).strict();
export type WayroostSettingsDocument = z.infer<typeof wayroostSettingsSchema>;

/** Partial group saves preserve siblings; arrays and complete provider choices replace their values. */
export function mergeWayroostSettingsPatch(document: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const params = { ...patch };
  for (const key of ['push', 'feed', 'workerUpdates', 'voice']) {
    if (Object.hasOwn(params, key)) params[key] = { ...(document[key] as object | undefined), ...(params[key] as object) };
  }
  return params;
}

export const wayroostPreferencesBodySchema = wayroostSettingsSchema.pick({ timeZone: true, feed: true })
  .refine(value => Object.keys(value).length > 0, 'at least one preference');
export const wayroostNotificationsPatchSchema = wayroostSettingsSchema.pick({ push: true, quietHours: true, rules: true })
  .refine(value => Object.keys(value).length > 0, 'at least one notification preference');
