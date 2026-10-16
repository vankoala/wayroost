import { accessSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationSummary, QuietReport } from '../../../shared/protocol.js';
import type { Sources } from '../sources.js';
import type { MaintenanceHold } from './maintenance.js';

export type QuietConversation = Pick<ConversationSummary, 'source' | 'id' | 'status' | 'pendingApprovals' | 'aliases'>;

/** A fresh count from Hermes activity sources, including outstanding approvals. */
export interface HermesActivitySnapshot {
  complete: boolean;
  runningTasks: number;
  openApprovalPrompts: number;
  conversations?: readonly QuietConversation[];
  isCurrent?(): boolean;
}

export interface QuietSources {
  sources: Sources & {
    hermes: Sources['hermes'] & { activitySnapshot?(): Promise<HermesActivitySnapshot> };
    paseo: Sources['paseo'] & { readonly agentsLoaded?: boolean; readonly activityVersion?: number;
      readActivityConversations?(activityRevision?: number): Promise<readonly QuietConversation[]> };
  };
  hold: MaintenanceHold;
  bridge?: { quietCounts(conversations?: readonly QuietConversation[]): {
    bridgeWaiters: number; queuedMessages: number; pendingDeliveries: number; generation?: number;
  } };
  tasks?: { quietCounts(): { pendingRelays: number; runningTaskIds: string[]; reasons?: string[] } };
}

type Count = 'bridgeWaiters' | 'queuedMessages' | 'pendingRelays' | 'pendingDeliveries' | 'runningTasks' | 'openApprovalPrompts';
type Counts = Record<Count, number>;
interface QuietSource<Read = Promise<Partial<Counts>>> {
  name: string;
  counts: readonly Count[];
  read(): Read;
}
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Every drain source is checked through the same registry; unknown counts are never zero. */
export async function quietReport(deps: QuietSources): Promise<QuietReport> {
  const paseoActivityRevision = deps.sources.paseo.activityVersion;
  const generation = deps.hold.generation;
  const backends = [deps.sources.hermes, deps.sources.paseo];
  const statuses = backends.map((source) => { try { return source.status(); } catch { return undefined; } });
  const reasons: string[] = [];
  const conversations: Array<readonly QuietConversation[]> = [[], []];
  let hermesActivity: HermesActivitySnapshot | undefined;
  const running = new Set<string>();
  let bridgeGeneration: number | undefined;
  let tasks: ReturnType<NonNullable<QuietSources['tasks']>['quietCounts']> | undefined;
  const taskCounts = () => {
    if (tasks) return tasks;
    if (deps.tasks) return tasks = deps.tasks.quietCounts();
    for (const file of ['tasks-quiet.json', 'tasks.json']) {
      try { accessSync(join(deps.hold.stateDir, file)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      throw new Error();
    }
    return tasks = { pendingRelays: 0, runningTaskIds: [] };
  };
  const hermes: Promise<HermesActivitySnapshot> = (async () => {
    if (statuses[0]?.state === 'disabled') return { complete: true, runningTasks: 0, openApprovalPrompts: 0 };
    if (statuses[0]?.state !== 'connected') throw new Error();
    const snapshot = await deps.sources.hermes.activitySnapshot?.();
    if (snapshot?.complete !== true) throw new Error();
    hermesActivity = snapshot;
    return snapshot;
  })();
  const lists = [hermes.then((snapshot) => conversations[0] = snapshot.conversations ?? []), (async () => {
    // Ask the daemon after the remote activity requests have settled.
    await Promise.allSettled([hermes]);
    if (statuses[1]?.state === 'disabled') return conversations[1] = [];
    if (statuses[1]?.state !== 'connected' || deps.sources.paseo.agentsLoaded === false) throw new Error();
    const snapshot = await deps.sources.paseo.readActivityConversations?.(paseoActivityRevision);
    if (!snapshot) throw new Error();
    return conversations[1] = snapshot;
  })()];
  // Observe every rejection immediately, including a list whose activity source is unavailable.
  const listed = Promise.allSettled(lists);
  const taskSources: QuietSource<Partial<Counts>>[] = [
    { name: 'tasks', counts: ['pendingRelays', 'runningTasks'], read() {
      const snapshot = taskCounts();
      if (snapshot.reasons?.includes('tasks_unavailable')) throw new Error();
      if (snapshot.reasons?.includes('tasks_unreconciled')) reasons.push('tasks_unreconciled');
      if (snapshot.reasons?.includes('relay_admission_unverified')) reasons.push('relay_admission_unverified');
      for (const id of snapshot.runningTaskIds) running.add(id);
      return { pendingRelays: snapshot.pendingRelays };
    } },
    { name: 'followups', counts: ['runningTasks'], read() {
      if (taskCounts().reasons?.includes('followups_unavailable')) throw new Error();
      if (taskCounts().reasons?.includes('followups_unreconciled')) reasons.push('followups_unreconciled');
      return {};
    } },
  ];
  const registry: QuietSource[] = [
    { name: 'bridge', counts: ['bridgeWaiters', 'queuedMessages', 'pendingDeliveries'], async read() {
      const initial = deps.bridge?.quietCounts();
      bridgeGeneration = initial?.generation;
      const results = await listed;
      if (deps.bridge && results.some((result) => result.status === 'rejected')) throw new Error();
      const snapshot = deps.bridge?.quietCounts(conversations.flat()) ?? { bridgeWaiters: 0, queuedMessages: 0, pendingDeliveries: 0 };
      if (snapshot.generation !== bridgeGeneration) reasons.push('bridge_changed');
      return { bridgeWaiters: snapshot.bridgeWaiters, queuedMessages: snapshot.queuedMessages, pendingDeliveries: snapshot.pendingDeliveries };
    } },
    { name: 'paseo_activity', counts: ['runningTasks', 'openApprovalPrompts'], async read() {
      if (statuses[1]?.state === 'disabled') return { openApprovalPrompts: 0 };
      const chats = await lists[1]!;
      for (const chat of chats) {
        if (chat.status === 'running' || chat.status === 'needs_approval') {
          running.add(chat.id);
          reasons.push('paseo_running');
        } else if (!['idle', 'error'].includes(chat.status)) throw new Error();
        if (!count(chat.pendingApprovals)) throw new Error();
      }
      const approvals = deps.sources.paseo.listApprovals();
      return { openApprovalPrompts: approvals.length + chats.reduce((sum, chat) => sum + Math.max(0, chat.pendingApprovals
        - approvals.filter((approval) => approval.conversationId === chat.id).length), 0) };
    } },
    { name: 'hermes_activity', counts: ['runningTasks', 'openApprovalPrompts'], async read() {
      if (statuses[0]?.state === 'disabled') return { runningTasks: 0, openApprovalPrompts: 0 };
      const snapshot = await hermes;
      return { runningTasks: snapshot.runningTasks, openApprovalPrompts: snapshot.openApprovalPrompts };
    } },
  ];
  const counts: Record<Count, number | null> = { bridgeWaiters: 0, queuedMessages: 0, pendingRelays: 0,
    pendingDeliveries: 0, runningTasks: 0, openApprovalPrompts: 0 };
  const checked = (result: Partial<Counts>) => {
    if (!Object.values(result).every((value) => value !== undefined && count(value))) throw new Error();
    return result;
  };
  const results = await Promise.allSettled(registry.map(async (source) => checked(await source.read())));
  // A tick may verify a launch while activity reads settle. Sample local tasks after the last await.
  for (const source of taskSources) {
    try { results.push({ status: 'fulfilled', value: checked(source.read()) }); }
    catch (reason) { results.push({ status: 'rejected', reason }); }
  }
  for (const [index, source] of [...registry, ...taskSources].entries()) {
    const result = results[index]!;
    if (result.status === 'rejected') {
      if (source.name === 'hermes_activity' && result.reason instanceof Error && result.reason.message === 'hermes_listing_incomplete') {
        reasons.push('hermes_listing_incomplete');
      }
      reasons.push(`${source.name}_unavailable`);
      for (const field of source.counts) counts[field] = null;
    } else {
      for (const [field, value] of Object.entries(result.value) as Array<[Count, number]>) {
        if (counts[field] !== null) counts[field] += value;
      }
    }
  }
  if (counts.runningTasks !== null) counts.runningTasks += running.size;
  if (paseoActivityRevision !== deps.sources.paseo.activityVersion) {
    reasons.push('paseo_activity_unavailable');
    counts.runningTasks = counts.openApprovalPrompts = null;
  }
  try {
    if (hermesActivity?.isCurrent?.() === false) {
      reasons.push('hermes_changed');
      counts.runningTasks = counts.openApprovalPrompts = null;
    }
  } catch {
    reasons.push('hermes_activity_unavailable');
    counts.runningTasks = counts.openApprovalPrompts = null;
  }
  for (const [index, source] of backends.entries()) {
    let current = false;
    try {
      const status = source.status();
      current = status.state === statuses[index]?.state && (status.state === 'disabled' ||
        status.state === 'connected' && status === statuses[index] && (index !== 1 || deps.sources.paseo.agentsLoaded !== false));
    } catch { /* Status failures remain unknown. */ }
    if (!current) {
      reasons.push(`${index === 0 ? 'hermes' : 'paseo'}_changed`);
      counts.runningTasks = counts.openApprovalPrompts = null;
    }
  }
  try {
    if (bridgeGeneration !== deps.bridge?.quietCounts(conversations.flat()).generation) reasons.push('bridge_changed');
  } catch { reasons.push('bridge_unavailable'); }
  if (generation !== deps.hold.generation) reasons.push('hold_changed');
  const held = deps.hold.isHeld();
  return { held, quiet: held && !reasons.length && Object.values(counts).every((value) => value === 0),
    ...counts, ...(reasons.length ? { reasons: [...new Set(reasons)] } : {}) };
}
