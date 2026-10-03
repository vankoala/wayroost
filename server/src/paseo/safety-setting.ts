import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ProviderOverridesSchema } from '@getpaseo/protocol/provider-config';
import { pendingWorkerApprovals, type PaseoConfigWriter, type WorkerApprovalsApi, type WorkerApprovalsStatus } from '../../../shared/safety.js';
import { CLOUD_AGENT_IDS, type CloudAgentId } from '../../../shared/protocol.js';
import { withPaseoConfigLock } from './config-lock.js';
import { applyApprovalsToMe, BUILTIN_PROVIDER_IDS, undoApprovalsToMe, withRoleProviders, type Providers } from './safety-config.js';

const Tools = z.object({ enabled: z.boolean().optional(), disabledTools: z.array(z.string()).optional() }).passthrough();
const Entry = z.object({ paseoTools: Tools.optional() }).passthrough();
const ProviderId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const Backup = z.record(ProviderId, z.object({ entry: z.enum(['existing', 'added']), before: Tools.optional(), applied: Tools }).strict());
const Prepared = z.object({ beforeRevision: z.string(), afterRevision: z.string(), previousBackup: Backup, committedBackup: Backup }).strict();
const State = z.object({ version: z.literal(1), enabled: z.boolean(), backup: Backup, reloadPending: z.boolean(), prepared: Prepared.optional() }).strict();
const Config = z.object({ agents: z.object({ providers: z.record(ProviderId, Entry).optional() }).passthrough().optional() }).passthrough();
const CONFIG_MAX_BYTES = 2 * 1024 * 1024;
// Undo records duplicate policies; a recovery journal holds three backups.
const STATE_MAX_BYTES = 16 * 1024 * 1024;

export interface SafetyDaemon {
  providers(): Promise<string[]>;
  effectiveProviders(): Promise<Providers>;
  reload(): Promise<{ appliedPaths: string[]; restartRequiredPaths: string[]; overrideControlledPaths: string[] }>;
}

function policyMatches(desired: Providers, effective: Providers, uncovered: string[], accounted: ReadonlySet<string>): boolean {
  const policy = (providers: Providers, id: string) => {
    const tools = Object.hasOwn(providers, id) ? providers[id]?.paseoTools : undefined;
    return { enabled: tools?.enabled ?? true, disabledTools: [...new Set(tools?.disabledTools ?? [])].sort() };
  };
  return [...new Set([...Object.keys(desired), ...Object.keys(effective)])].every(id =>
    accounted.has(id) && (uncovered.includes(id) || isDeepStrictEqual(policy(desired, id), policy(effective, id))));
}

class SafetyConflictError extends Error {}

class SafetyWriteError extends Error {
  constructor(cause: unknown, readonly commit: 'uncommitted' | 'uncertain' | 'replaced') {
    super(cause instanceof Error ? cause.message : 'Safety file write failed.', { cause });
  }
}

const serialized = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const serializedWithinLimit = (value: unknown, maxBytes: number): string => {
  const contents = serialized(value);
  if (Buffer.byteLength(contents, 'utf8') > maxBytes) throw new Error(`Safety file must contain at most ${maxBytes / (1024 * 1024)} MiB of serialized JSON.`);
  return contents;
};

/** Private files, written whole in the same directory; no path comes from an RPC request. */
function atomicSafetyWrite(path: string, value: unknown, maxBytes: number, expectedRevision?: string): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let commit: SafetyWriteError['commit'] = 'uncommitted';
  try {
    try {
      const contents = serializedWithinLimit(value, maxBytes);
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, contents);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // Check after preparing and flushing the candidate, immediately before rename.
      if (expectedRevision !== undefined) {
        try { if (privateSnapshot(path, maxBytes).revision !== expectedRevision) return false; }
        catch (err) { if (err instanceof SafetyConflictError) return false; throw err; }
      }
      commit = 'uncertain';
      renameSync(temporary, path);
      commit = 'replaced';
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return true;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  } catch (err) {
    throw new SafetyWriteError(err, commit);
  }
}

function privateSnapshot(path: string, maxBytes = CONFIG_MAX_BYTES): { contents: string; revision: string } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`Safety file must be a regular file of at most ${maxBytes / (1024 * 1024)} MiB.`);
  const contents = readFileSync(path, 'utf8');
  const after = lstatSync(path, { bigint: true });
  if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
    throw new SafetyConflictError('Paseo configuration conflict: the file changed while reading; retry the Safety change.');
  }
  return { contents, revision: `${revision(contents)}:${after.mtimeNs}:${after.size}:${after.ino}` };
}

const privateContents = (path: string): string => privateSnapshot(path).contents;

const revision = (contents: string): string => createHash('sha256').update(contents).digest('hex');
const privateJson = (path: string, maxBytes: number): unknown => JSON.parse(privateSnapshot(path, maxBytes).contents);

/** Runs as the Paseo owner, with a fixed config and a separate Wayroost state directory. */
export class WorkerApprovalsSetting implements WorkerApprovalsApi, PaseoConfigWriter {
  private readonly statePath: string;
  private state: z.infer<typeof State>;
  private queue: Promise<unknown> = Promise.resolve();
  private result = pendingWorkerApprovals();
  private firstRead = true;

  constructor(private readonly configPath: string, private readonly stateDir: string, private readonly daemon: SafetyDaemon) {
    this.statePath = join(stateDir, 'worker-approvals.json');
    try {
      this.state = State.parse(privateJson(this.statePath, STATE_MAX_BYTES));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Safety state is invalid; restore its backup before changing the policy.');
      this.state = { version: 1, enabled: true, backup: {}, reloadPending: true };
    }
    // A new daemon may have started since the helper last ran.
    this.state.reloadPending = true;
  }

  /** A pure read in both roles: no lock file, state or config write, and no reload. */
  status(): Promise<WorkerApprovalsStatus> {
    const next = this.queue.then(() => this.inspect());
    this.queue = next.catch(() => {});
    return next;
  }
  reconcile(): Promise<WorkerApprovalsStatus> { return this.run(); }
  setEnabled(enabled: boolean): Promise<WorkerApprovalsStatus> { return this.run(enabled); }

  private run(enabled?: boolean): Promise<WorkerApprovalsStatus> {
    return this.enqueue(() => this.apply(enabled));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      this.result = { ...pendingWorkerApprovals(), enabled: this.state.enabled };
      return withPaseoConfigLock(this.configPath, this.stateDir, async () => {
        // Another helper instance may have saved a choice or backup since construction.
        try { this.state = State.parse(privateJson(this.statePath, STATE_MAX_BYTES)); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Safety state is invalid; restore its backup before changing the policy.');
        }
        if (this.firstRead) { this.state.reloadPending = true; this.firstRead = false; }
        return work();
      });
    });
    this.queue = next.catch(() => {});
    return next;
  }

  setCloudAgentEnabled(id: CloudAgentId, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!CLOUD_AGENT_IDS.includes(id)) throw new Error('Unknown cloud agent.');
      this.recoverPrepared();
      const pending = { ...this.state, reloadPending: true };
      atomicSafetyWrite(this.statePath, pending, STATE_MAX_BYTES);
      this.state = pending;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = privateSnapshot(this.configPath);
        const config = Config.parse(JSON.parse(snapshot.contents));
        const providers = config.agents?.providers ?? {};
        const candidate = { ...config, agents: { ...config.agents, providers: {
          ...providers, [id]: { ...providers[id], enabled },
        } } };
        if (!atomicSafetyWrite(this.configPath, candidate, CONFIG_MAX_BYTES, snapshot.revision)) continue;
        const written = privateSnapshot(this.configPath);
        if (written.contents !== serialized(candidate)) throw new Error('Paseo configuration conflict after switching the cloud agent.');
        const reload = await this.daemon.reload();
        const affectsProvider = (path: string) => path === 'agents' || path === 'agents.providers' || path.startsWith(`agents.providers.${id}`);
        if (reload.restartRequiredPaths.some(affectsProvider) || reload.overrideControlledPaths.some(affectsProvider)) {
          throw new Error('Paseo has not applied the cloud agent switch.');
        }
        const effective = await this.daemon.effectiveProviders();
        if ((effective[id]?.enabled ?? true) !== enabled || privateSnapshot(this.configPath).revision !== written.revision) {
          throw new Error('Paseo configuration or policy changed while verifying the cloud agent switch.');
        }
        return;
      }
      throw new Error('Paseo configuration conflict: the cloud agent switch changed on all three attempts.');
    });
  }

  private async apply(enabled?: boolean): Promise<WorkerApprovalsStatus> {
    let offered: string[];
    try { offered = await this.daemon.providers(); }
    catch {
      // Discovery failed before checking the current config and live policy.
      this.result = { ...pendingWorkerApprovals(), enabled: this.state.enabled, reload: 'failed', message: 'Paseo could not be reached. The saved choice has not changed; its configuration and policy have not been confirmed.' };
      return this.result;
    }
    let policy: ReturnType<WorkerApprovalsSetting['writePolicy']>;
    try { policy = this.writePolicy(offered, enabled); }
    catch (err) {
      this.result = { ...pendingWorkerApprovals(), enabled: this.state.enabled, message: err instanceof Error ? err.message : undefined };
      if (err instanceof SafetyConflictError) return this.result;
      throw err;
    }
    const { providers, uncovered, accounted, chosen, configRevision } = policy;
    this.result = { ...pendingWorkerApprovals(), enabled: chosen, uncoveredProviders: uncovered };
    try {
      // The daemon can change independently of the file, even after a confirmed
      // reload. Reconcile its live policy before reporting a settled setting.
      let effective = this.state.reloadPending ? undefined : await this.daemon.effectiveProviders();
      if (effective && !policyMatches(providers, effective, uncovered, accounted)) {
        atomicSafetyWrite(this.statePath, { ...this.state, reloadPending: true }, STATE_MAX_BYTES);
        this.state.reloadPending = true;
      }
      if (this.state.reloadPending) {
        const reload = await this.daemon.reload();
        const affectsPolicy = (path: string) => path === 'agents' || path === 'agents.providers' || path.startsWith('agents.providers.');
        if (reload.restartRequiredPaths.some(affectsPolicy) || reload.overrideControlledPaths.some(affectsPolicy)) {
          return { ...this.result, message: 'The policy was saved, but Paseo has not applied it. A restart or removal of an override is required.' };
        }
        // appliedPaths lists changes, so a restart or lost response can yield a
        // successful no-op. Confirm the live policy, including limits removed by undo.
        effective = await this.daemon.effectiveProviders();
      }
      if (!effective || !policyMatches(providers, effective, uncovered, accounted)) {
        return { ...this.result, message: 'The policy was saved, but Paseo\'s effective provider policy differs. The helper will retry.' };
      }
      if (this.state.reloadPending) {
        atomicSafetyWrite(this.statePath, { ...this.state, reloadPending: false }, STATE_MAX_BYTES);
        this.state.reloadPending = false;
        effective = await this.daemon.effectiveProviders();
      }
      // Read disk after the last awaited daemon call and state write. An owner
      // edit invalidates confirmation even when the daemon returned an old snapshot.
      const configCurrent = privateSnapshot(this.configPath).revision === configRevision;
      if (!configCurrent || !policyMatches(providers, effective, uncovered, accounted)) {
        atomicSafetyWrite(this.statePath, { ...this.state, reloadPending: true }, STATE_MAX_BYTES);
        this.state.reloadPending = true;
        return { ...this.result, message: 'Paseo configuration or policy changed during verification. The setting is not confirmed; the helper will retry.' };
      }
    } catch {
      if (!this.state.reloadPending) {
        atomicSafetyWrite(this.statePath, { ...this.state, reloadPending: true }, STATE_MAX_BYTES);
        this.state.reloadPending = true;
      }
      return { ...this.result, reload: 'failed', message: 'The policy was saved. Paseo policy verification or reload failed; the helper will retry.' };
    }
    this.result = { ...this.result, config: 'written', reload: 'applied', application: 'partial', message: 'The daemon\'s provider policy matches the saved setting. Existing agents keep their earlier policy; caller identity can still be bypassed.' };
    return this.result;
  }

  private async inspect(): Promise<WorkerApprovalsStatus> {
    let state = this.state;
    const stateSnapshot = () => {
      try { return privateSnapshot(this.statePath, STATE_MAX_BYTES); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
    };
    let stateRevision: string | undefined;
    try {
      const snapshot = stateSnapshot();
      stateRevision = snapshot?.revision;
      state = snapshot ? State.parse(JSON.parse(snapshot.contents)) : { version: 1, enabled: true, backup: {}, reloadPending: true };
    }
    catch (err) {
      if (err instanceof SafetyConflictError) return { ...pendingWorkerApprovals(), enabled: state.enabled, message: err.message };
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Safety state is invalid; restore its backup before changing the policy.');
    }
    const pending = { ...pendingWorkerApprovals(), enabled: state.enabled };
    if (state.prepared) {
      return { ...pending, message: 'A previous Safety change is unconfirmed. Change the setting to finish it, or wait for primary reconciliation.' };
    }
    let config: ReturnType<typeof privateSnapshot>;
    try { config = privateSnapshot(this.configPath); }
    catch (err) {
      if (err instanceof SafetyConflictError) return { ...pending, message: err.message };
      throw err;
    }
    let result: WorkerApprovalsStatus;
    try {
      const offered = await this.daemon.providers();
      const { providers, changed, uncovered, accounted } = this.plan(config.contents, offered, state.enabled, state.backup);
      result = { ...pending, choiceConfirmed: true, config: changed ? 'pending' : 'written', uncoveredProviders: uncovered };
      try {
        if (changed || !policyMatches(providers, await this.daemon.effectiveProviders(), uncovered, accounted)) {
          result = { ...result, message: 'The saved policy needs application. Apply the saved setting, or wait for primary reconciliation.' };
        } else {
          result = { ...result, reload: 'applied', application: 'partial', message: 'The daemon matches the saved policy. Existing agents retain earlier policy; caller identity can still be bypassed.' };
        }
      } catch {
        result = { ...result, reload: 'failed', message: 'Paseo policy verification failed. The saved setting has not changed.' };
      }
    } catch {
      result = { ...pending, reload: 'failed', message: 'Paseo could not be reached. The saved setting has not been confirmed.' };
    }
    // Confirm both snapshots after the last await, including failed daemon reads.
    // A missing state file is a revision too: another helper may create it.
    try {
      if (stateSnapshot()?.revision === stateRevision && privateSnapshot(this.configPath).revision === config.revision) return result;
    } catch { /* Unreadable snapshots cannot confirm the earlier choice or policy. */ }
    return { ...pending, message: 'The Safety state or Paseo configuration changed during verification. Check again before applying the setting.' };
  }

  /** Plans the provider policy for one config snapshot without writing anything. */
  private plan(contents: string, offered: string[], chosen: boolean, previous: z.infer<typeof Backup>) {
    const config = Config.parse(JSON.parse(contents));
    const current = config.agents?.providers ?? {};
    const builtins = new Set<string>(BUILTIN_PROVIDER_IDS);
    const valid = (id: string) => Object.hasOwn(current, id) && ProviderOverridesSchema.safeParse({ [id]: current[id] }).success;
    const uncovered = [...new Set([...offered, ...Object.keys(current)])].filter(id =>
      Object.hasOwn(current, id) ? !valid(id) : !builtins.has(id));
    const editable: Providers = Object.fromEntries(Object.entries(current).filter(([id]) => valid(id)));
    // A plugin with a reserved role id must stay uncovered, rather than be shadowed.
    const roles = withRoleProviders(editable);
    for (const id of uncovered) delete roles[id];
    const on = chosen ? applyApprovalsToMe(roles, previous) : undefined;
    // Uncovered entries stay untouched, so their undo records must survive until
    // they become editable again or the owner removes them.
    const deferred = Object.fromEntries(Object.entries(previous).filter(([id]) => Object.hasOwn(current, id) && uncovered.includes(id)));
    const backup = on ? { ...Object.fromEntries(Object.entries(on.backup).filter(([id]) => !uncovered.includes(id))), ...deferred } : previous;
    const restored = on?.providers ?? withRoleProviders(undoApprovalsToMe(roles, previous));
    for (const id of uncovered) delete restored[id];
    const providers = { ...Object.fromEntries(Object.entries(current).filter(([id]) => !Object.hasOwn(editable, id))), ...restored };
    const changed = !isDeepStrictEqual(current, providers);
    // Default policies are comparable only for providers seen during planning.
    // An effective provider discovered later needs its own reconciliation.
    const accounted: ReadonlySet<string> = new Set([...offered, ...Object.keys(current), ...Object.keys(providers)]);
    return { config, current, uncovered, providers, changed, backup, deferred, accounted };
  }

  private recoverPrepared(): void {
    const prepared = this.state.prepared;
    if (!prepared) return;
    const currentRevision = revision(privateContents(this.configPath));
    if (currentRevision !== prepared.beforeRevision && currentRevision !== prepared.afterRevision) {
      throw new Error('A previous Safety configuration write is unconfirmed and the config changed. Restore its backup before changing the policy.');
    }
    const { prepared: _prepared, ...saved } = this.state;
    const recovered = { ...saved, backup: currentRevision === prepared.afterRevision ? prepared.committedBackup : prepared.previousBackup };
    atomicSafetyWrite(this.statePath, recovered, STATE_MAX_BYTES);
    this.state = recovered;
  }

  private writePolicy(offered: string[], enabled?: boolean): { providers: Providers; uncovered: string[]; accounted: ReadonlySet<string>; chosen: boolean; configRevision: string } {
    this.recoverPrepared();
    const original = this.state;
    const chosen = enabled ?? original.enabled;
    // Cooperating writers share the lock. Retry edits by other writers from fresh content.
    for (let attempt = 0; attempt < 3; attempt++) {
      let snapshot: ReturnType<typeof privateSnapshot>;
      try { snapshot = privateSnapshot(this.configPath); }
      catch (err) { if (err instanceof SafetyConflictError) continue; throw err; }
      const { contents } = snapshot;
      const { config, uncovered, providers, changed, backup, deferred, accounted } = this.plan(contents, offered, chosen, this.state.backup);
      const saved = { version: 1 as const, enabled: chosen, backup, reloadPending: changed || this.state.reloadPending };
      const candidate = { ...config, agents: { ...config.agents, providers } };
      // Reject config growth before persisting a speculative choice or undo journal.
      const candidateContents = changed ? serializedWithinLimit(candidate, CONFIG_MAX_BYTES) : contents;
      const committed = { ...saved, backup: chosen ? backup : deferred };
      // Journal both backups before replacement. After an uncertain write or crash,
      // the config revision determines which backup actually belongs to the file.
      const prepared = changed ? { ...saved, backup: original.backup, prepared: {
        beforeRevision: revision(contents), afterRevision: revision(candidateContents),
        previousBackup: original.backup, committedBackup: committed.backup,
      } } : saved;
      atomicSafetyWrite(this.statePath, prepared, STATE_MAX_BYTES);
      this.state = prepared;
      let written: boolean;
      try {
        written = changed
          ? atomicSafetyWrite(this.configPath, candidate, CONFIG_MAX_BYTES, snapshot.revision)
          : privateSnapshot(this.configPath).revision === snapshot.revision;
      } catch (err) {
        let uncommitted = !changed || (err instanceof SafetyWriteError && err.commit === 'uncommitted');
        if (err instanceof SafetyWriteError && err.commit === 'uncertain') {
          try { uncommitted = privateSnapshot(this.configPath).revision === snapshot.revision; }
          catch { /* Failed verification leaves the recovery journal intact. */ }
        }
        if (uncommitted) {
          const restored = { ...saved, backup: original.backup };
          atomicSafetyWrite(this.statePath, restored, STATE_MAX_BYTES);
          this.state = restored;
        }
        throw err;
      }
      if (!written) {
        // No policy was replaced: discard the speculative undo record before retrying.
        const pending = { ...original, enabled: chosen, reloadPending: true };
        atomicSafetyWrite(this.statePath, pending, STATE_MAX_BYTES);
        this.state = pending;
        continue;
      }
      // Confirm the entire candidate, including all owner settings, after replacement.
      // Keep both undo records on conflict, including records an undo would clear.
      const conflict = (message: string): never => {
        const retained = { ...saved, backup: { ...original.backup, ...committed.backup }, reloadPending: true };
        atomicSafetyWrite(this.statePath, retained, STATE_MAX_BYTES);
        this.state = retained;
        throw new SafetyConflictError(message);
      };
      let writtenSnapshot: ReturnType<typeof privateSnapshot>;
      try { writtenSnapshot = privateSnapshot(this.configPath); }
      catch {
        return conflict('Paseo configuration conflict: the file could not be verified after writing. The setting is not confirmed; its undo backup was kept.');
      }
      if (changed && writtenSnapshot.contents !== candidateContents) {
        return conflict('Paseo configuration conflict after writing. The setting is not confirmed; its undo backup was kept.');
      }
      if (!changed && writtenSnapshot.revision !== snapshot.revision) {
        return conflict('Paseo configuration conflict during verification. The setting is not confirmed; its undo backup was kept.');
      }
      if (changed || !chosen) {
        atomicSafetyWrite(this.statePath, committed, STATE_MAX_BYTES);
        this.state = committed;
      }
      return { providers, uncovered, accounted, chosen, configRevision: writtenSnapshot.revision };
    }
    const pending = { ...original, enabled: chosen, reloadPending: true };
    atomicSafetyWrite(this.statePath, pending, STATE_MAX_BYTES);
    this.state = pending;
    throw new SafetyConflictError('Paseo configuration conflict: the file changed on all three attempts. The choice was saved; retry the Safety change.');
  }
}
