import { z } from 'zod';
import type { CloudAgentId } from './protocol.js';
import { settingValueSchema, type SettingValue } from './settings.js';

export const WORKER_APPROVAL_TOOLS = ['respond_to_permission', 'set_agent_mode', 'update_agent'] as const;

/** Preserve other tool choices while changing whether workers may answer approvals. */
export function workerApprovalTools(value: unknown, enabled: boolean): Record<string, SettingValue> {
  const tools = z.record(z.string(), settingValueSchema).parse(value ?? {});
  const disabled = z.array(z.string()).parse(tools.disabledTools ?? []);
  return { ...tools, disabledTools: enabled ? [...new Set([...disabled, ...WORKER_APPROVAL_TOOLS])]
    : disabled.filter(tool => !(WORKER_APPROVAL_TOOLS as readonly string[]).includes(tool)) };
}

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
  setEnabled(enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<void>): Promise<WorkerApprovalsStatus>;
  /** Hold new writes until acknowledged cancellation and device revocation finish. */
  cancelPending?(signal: AbortSignal): Promise<() => void>;
}

export function pendingWorkerApprovals(): WorkerApprovalsStatus {
  return {
    enabled: true, application: 'pending', config: 'pending', reload: 'pending', choiceConfirmed: false, uncoveredProviders: [],
    limitations: ['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed'],
    message: 'The Safety helper is unavailable. The default is on; its policy has not been confirmed.',
  };
}

export interface PaseoConfigWriter {
  setCloudAgentEnabled(id: CloudAgentId, enabled: boolean, signal?: AbortSignal, authorize?: () => Promise<void>): Promise<void>;
}
