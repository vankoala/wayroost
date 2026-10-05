// The Checks service: take one snapshot, run every check over it, answer the rows.
// The sources are injected, so a page load costs one pass over them and no check
// ever opens a file or a connection itself.
import type { SettingsChecksResponse } from '../../../shared/settings-checks.js';
import type { SettingsAuditEntry } from '../settings/audit.js';
import { ChecksState, type IntentFact } from './state.js';
import type { SettingsErrorCode } from '../../../shared/settings.js';
import { settingValuesEqual } from '../../../shared/settings.js';
import type { MigrationTargetRecord } from '../../../shared/gateway.js';
import { CHECK_VIEWS, runChecks } from './engine.js';
import { collectSnapshot, type ChecksDeployment, type ChecksSources } from './snapshot.js';
import type { CheckContext } from './engine.js';
import { comparisonHeld } from './common.js';

export interface ChecksOptions {
  now?: () => number;
  sourceTimeoutMs?: number;
  phoneTimeoutMs?: number;
  gatewayTimeoutMs?: number;
  ownerTimeoutMs?: number;
  budgetMs?: number;
}

export class Checks {
  private state?: ChecksState;
  useState(stateDir: string): void { this.state = new ChecksState(stateDir); }
  async confirmIntent(id: string, at: number): Promise<void> { await this.state?.confirm(id, at); }
  async recordIntent(fact: IntentFact, entries?: readonly SettingsAuditEntry[]): Promise<void> { await this.state?.record(fact, entries); }
  async confirmUndo(id: string, undoOf: string, at: number, entries: readonly SettingsAuditEntry[]): Promise<void> {
    await this.state?.confirmUndo(id, undoOf, at, entries);
  }
  async resolveIntent(id: string, entries: readonly SettingsAuditEntry[]): Promise<{ operation: string; params: Record<string, unknown>; at?: number; paths: import('../../../shared/settings.js').KeyPath[] } | undefined> {
    return this.state?.reapply(id, entries);
  }
  async canReapplyMigration(record: MigrationTargetRecord, entries: readonly SettingsAuditEntry[]): Promise<boolean> {
    if (!this.state || record.keys.some(key => key.path[0] === 'command_allowlist')) return false;
    const movedAt = Date.parse(record.movedAt ?? '') || 0;
    const effective = await this.state.effective(entries);
    return record.keys.every(key => !effective.intended.some(held => (held.at ?? 0) >= movedAt
      && settingValuesEqual([...held.path], key.path) && !settingValuesEqual(comparisonHeld(held.intended), comparisonHeld(key.intended))));
  }
  constructor(private readonly sources: ChecksSources | (() => ChecksSources), private readonly deployment: ChecksDeployment = {},
    private readonly options: ChecksOptions = {}) {}

  async rows(entries?: readonly SettingsAuditEntry[], context?: CheckContext['settingsContext']): Promise<SettingsChecksResponse> {
    const effective = this.state && entries ? this.state.effective(entries) : undefined;
    const configured = typeof this.sources === 'function' ? this.sources() : this.sources;
    const sources = effective ? { ...configured,
      intended: async () => (await effective).intended,
      revocations: async () => {
        const state = await effective;
        if (!state.revocationsComplete) throw new Error('unavailable');
        return state.revocations;
      },
      recentChanges: async () => entries!.slice(-64).reverse().map(entry => ({
        id: entry.id, at: entry.at, action: entry.action, operation: entry.operation, target: entry.target, result: entry.result,
      })),
    } : configured;
    // Collection observes each failure independently.
    void effective?.catch(() => {});
    const snapshot = await collectSnapshot(sources, this.deployment, {
      ...this.options, views: CHECK_VIEWS,
    });
    const rows = runChecks(snapshot, undefined, context);
    const unavailable = [...new Set([...CHECK_VIEWS.map(id => snapshot.views[id]), snapshot.supervisor, snapshot.gateway,
      snapshot.phone, snapshot.coderProcesses, snapshot.drainMarker, snapshot.directoryRule, snapshot.switchFlags,
      snapshot.revocations, snapshot.changes, snapshot.intended]
      .filter(observation => observation !== undefined && !observation.ok)
      .map(observation => (observation as { code?: SettingsErrorCode }).code ?? 'unavailable'))].slice(0, 8);
    return { generatedAt: snapshot.at, rows, ...(unavailable.length ? { unavailable } : {}) };
  }
}

export { CHECKS, CHECK_IDS, CHECK_VIEWS, runChecks } from './engine.js';
export type { Check, CheckContext, CheckRowInput, CheckSourceKey } from './engine.js';
export type { ChecksDeployment, ChecksSources, Observation } from './snapshot.js';
