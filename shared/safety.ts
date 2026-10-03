import { z } from 'zod';
import type { CloudAgentId } from './protocol.js';

export const WorkerApprovalsWrite = z.object({ enabled: z.boolean() }).strict();
export type WorkerApprovalsWrite = z.infer<typeof WorkerApprovalsWrite>;
export const WorkerApprovalsStatus = z.object({
  enabled: z.boolean(),
  application: z.enum(['pending', 'partial']),
  config: z.enum(['pending', 'written']),
  reload: z.enum(['pending', 'applied', 'failed']),
  // A fresh saved choice can be applied even when its policy is still pending.
  choiceConfirmed: z.boolean().optional(),
  uncoveredProviders: z.array(z.string()),
  limitations: z.array(z.enum(['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed'])),
  message: z.string().optional(),
}).strict();
export type WorkerApprovalsStatus = z.infer<typeof WorkerApprovalsStatus>;
export interface WorkerApprovalsApi {
  status(): Promise<WorkerApprovalsStatus>;
  setEnabled(enabled: boolean): Promise<WorkerApprovalsStatus>;
}

export function pendingWorkerApprovals(): WorkerApprovalsStatus {
  return {
    enabled: true, application: 'pending', config: 'pending', reload: 'pending', choiceConfirmed: false, uncoveredProviders: [],
    limitations: ['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed'],
    message: 'The Safety helper is unavailable. The default is on; its policy has not been confirmed.',
  };
}

export interface PaseoConfigWriter {
  setCloudAgentEnabled(id: CloudAgentId, enabled: boolean): Promise<void>;
}
