import type { ConversationSummary, Source } from '../../../shared/protocol.js';
import { readableBridgeText } from '../bridge/envelope.js';
import { oneLine, str } from '../text.js';
import { earlierIds, folderLabel, projectOf, shortModel, type HermesSessionRow } from './normalize.js';

// Hermes delegate_task runs ("sub-agents"), listed under the chat that ran them. Hermes lists
// them only with `sessions.show_subagents` on (hermes_cli/session_listing.py), gives each the
// parent's id at spawn time (maybe an earlier id of a compressed chat), and titles them
// "Subagent: <goal>" (agent/title_generator.py).

/** At most this many runs per parent, newest first. */
export const SUBAGENTS_PER_PARENT = 20;

type Parent = { source: Source; id: string };

export interface SubagentEntry {
  row: HermesSessionRow;
  /** Where it nests; absent for a run whose parent can't be found that's still running. */
  parent?: Parent;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lastActive = (row: HermesSessionRow) => row.last_active ?? row.started_at ?? 0;

/** Where a chat that moved (compression, seen live) continues, following the whole chain. */
function follow(moves: ReadonlyMap<string, string> | undefined, id: string): string | undefined {
  let next = moves?.get(id);
  for (let hops = 0; next && moves?.has(next) && hops < 20; hops++) next = moves.get(next);
  return next;
}

/**
 * The runs among `rows` (the sub-agent listing), each with the chat it nests under. A run has
 * a parent and isn't a /branch or /new copy, or a listed chat. Parents, first match wins:
 *
 * 1. a listed chat;
 * 2. an earlier id of a listed chat (its `_lineage_ids`), or one Signalbox saw move;
 * 3. another run, or an earlier id of one. A run that ended in compression is the child's own
 *    earlier segment: it's hidden, and its parent is used;
 * 4. a uuid: an ACP session (Hermes in Paseo), which its Paseo agent carries as an alias;
 * 5. an earlier id of an ACP session, from `acp` (its first id is the uuid). Without `acp`,
 *    `needsAcp` says whether any run got this far;
 * 6. none: the run is dropped, unless it's still active.
 *
 * Then at most SUBAGENTS_PER_PARENT per parent, newest first.
 */
export function resolveSubagents(input: {
  listed: HermesSessionRow[];
  rows: HermesSessionRow[];
  movedTo?: ReadonlyMap<string, string>;
  acp?: HermesSessionRow[];
}): { entries: SubagentEntry[]; needsAcp: boolean } {
  const listed = new Set(input.listed.map((r) => r.id));
  const listedEarlier = new Map<string, string>();
  for (const r of input.listed) for (const { id } of earlierIds(r)) listedEarlier.set(id, r.id);

  // Hermes can list a compressed run twice under its current id: projected from its first
  // segment (carrying the lineage and the real parent) and as that segment's continuation.
  const runs = new Map<string, HermesSessionRow>();
  for (const r of input.rows) {
    if (!r.id || !r.parent_session_id || r._branched_from || r._reset_from || listed.has(r.id)) continue;
    const seen = runs.get(r.id);
    if (!seen || (!seen._lineage_ids?.length && r._lineage_ids?.length)) runs.set(r.id, r);
  }
  const runEarlier = new Map<string, string>();
  for (const r of runs.values()) for (const { id } of earlierIds(r)) runEarlier.set(id, r.id);
  const acpRoot = new Map<string, string>();
  for (const r of input.acp ?? []) {
    const root = r._lineage_root_id ?? r.id;
    for (const id of [r.id, ...(r._lineage_ids ?? [])]) if (id) acpRoot.set(id, root);
  }

  const hidden = new Set<string>();
  let needsAcp = false;
  const parentOf = (row: HermesSessionRow, depth = 0): Parent | undefined => {
    const p = row.parent_session_id;
    if (!p) return undefined;
    if (listed.has(p)) return { source: 'hermes', id: p };
    const moved = listedEarlier.get(p) ?? follow(input.movedTo, p);
    if (moved) return { source: 'hermes', id: moved };
    const run = runs.get(p) ?? runs.get(runEarlier.get(p) ?? '');
    if (run && run.id !== row.id) {
      if (run.end_reason !== 'compression') return { source: 'hermes', id: run.id };
      hidden.add(run.id);
      return depth < 20 ? parentOf(run, depth + 1) : undefined;
    }
    if (UUID.test(p)) return { source: 'hermes', id: p };
    if (!input.acp) {
      needsAcp = true;
      return undefined;
    }
    const root = acpRoot.get(p);
    return root ? { source: 'hermes', id: root } : undefined;
  };

  const resolved = [...runs.values()].map((row) => ({ row, parent: parentOf(row) }));
  const count = new Map<string, number>();
  const entries: SubagentEntry[] = [];
  for (const entry of resolved.sort((a, b) => lastActive(b.row) - lastActive(a.row))) {
    if (hidden.has(entry.row.id)) continue;
    if (!entry.parent && entry.row.is_active !== true) continue;
    const key = entry.parent ? `${entry.parent.source}:${entry.parent.id}` : '';
    const n = count.get(key) ?? 0;
    if (n >= SUBAGENTS_PER_PARENT) continue;
    count.set(key, n + 1);
    entries.push(entry.parent ? entry : { row: entry.row });
  }
  return { entries, needsAcp };
}

/** A run as a read-only conversation under its parent. */
export function subagentSummary({ row, parent }: SubagentEntry, defaultFolder?: string): ConversationSummary {
  const preview = str(row.preview) ? oneLine(readableBridgeText(row.preview!), 140) : undefined;
  const goal = str(row.title)?.replace(/^Subagent:\s*/, '').trim();
  const model = shortModel(row.model);
  const project = projectOf(row.cwd);
  const aliases = earlierIds(row);
  return {
    source: 'hermes',
    id: row.id,
    title: goal ? oneLine(goal, 80) : preview ? oneLine(preview, 60) : 'Sub-agent',
    subtitle: ['Sub-agent', folderLabel(row.cwd, defaultFolder), model].filter(Boolean).join(' · '),
    ...(preview ? { preview } : {}),
    status: row.ended_at == null && row.is_active === true ? 'running' : 'idle',
    updatedAt: Math.round(lastActive(row) * 1000),
    pendingApprovals: 0,
    ...(project ? { project } : {}),
    ...(model ? { agentLabel: model } : {}),
    ...(parent ? { parent } : {}),
    ...(aliases.length ? { aliases } : {}),
    subagent: true,
  };
}

/** A detail row (`/api/sessions/<id>`) of a delegate_task run, or of a continuation of one. */
export function isDelegateRun(row: HermesSessionRow): boolean {
  let config: unknown = row.model_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch {
      return false;
    }
  }
  return typeof config === 'object' && config !== null && Boolean(str((config as { _delegate_from?: unknown })._delegate_from));
}
