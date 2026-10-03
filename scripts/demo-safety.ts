// "Workers' approvals come to me" for the demo and the UI check: the setting as the
// owner-side helper would report it, kept in memory. Nothing touches a Paseo config.
import type { WorkerApprovalsApi, WorkerApprovalsStatus } from '../shared/safety.js';

export class DemoWorkerApprovals implements WorkerApprovalsApi {
  private enabled = true;

  async status(): Promise<WorkerApprovalsStatus> {
    return {
      enabled: this.enabled,
      // Paseo has it; coverage is never complete (see docs/worker-approvals.md).
      application: 'partial',
      config: 'written',
      reload: 'applied',
      uncoveredProviders: ['demo-plugin'],
      limitations: ['existing_agents', 'caller_identity', 'same_user_config', 'cli_guard_not_installed'],
    };
  }

  async setEnabled(enabled: boolean): Promise<WorkerApprovalsStatus> {
    this.enabled = enabled;
    return this.status();
  }
}
