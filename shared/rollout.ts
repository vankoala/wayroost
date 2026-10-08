import { z } from 'zod';

/** Site switches enable settings writes and choose the new-chat default. */
export const rolloutSchema = z.object({
  settingsPages: z.boolean().default(false),
  revokes: z.boolean().default(false),
  chatFirst: z.boolean().default(false),
}).strict().prefault({});
export type Rollout = z.infer<typeof rolloutSchema>;
