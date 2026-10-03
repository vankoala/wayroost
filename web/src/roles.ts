// The cast. A role is a rounded tile in the role's colour with a
// glyph; its state shows as a badge on the corner. People see roles (Manager, Agent,
// Coder…), not engines: an approval card names the role that asks (roleOf), and the
// engine is a detail one level down (engineOf).
//
// M1 has no per-role state yet — a role is a job on one of the two engines — so a
// role's badge comes from the chats its engine runs. M2 Team replaces this with the
// role's own ledger.

import type { Approval, ConversationSummary, Source } from '../../shared/protocol';
import { ROLE_NAMES, type Role, type RoleId } from '../../shared/roles';

export { ROLE_NAMES, engineOf, roleOf, type Role, type RoleId } from '../../shared/roles';

/** Idle shows no badge at all. */
export type RoleState = 'idle' | 'working' | 'needs' | 'stuck' | 'finished';

/** A role on the Team page: what it is for, and the engine its work runs on today. */
export interface TeamRole extends Role {
  /** One line on what the role is for, for the Team page. */
  about: string;
  /** The engine this role's work runs on today (see the note above). */
  source: Source;
}

export const ROLES: readonly TeamRole[] = [
  { id: 'manager', name: ROLE_NAMES.manager, about: 'Plans the work, hands it out, tells you when something is ready.', source: 'hermes' },
  { id: 'agent', name: ROLE_NAMES.agent, about: 'Talks to you and gets ordinary things done.', source: 'hermes' },
  { id: 'coder', name: ROLE_NAMES.coder, about: 'Writes and runs code in your projects.', source: 'paseo' },
  { id: 'reviewer', name: ROLE_NAMES.reviewer, about: 'Reads what changed and says whether it is safe.', source: 'paseo' },
  { id: 'scout', name: ROLE_NAMES.scout, about: 'Looks things up: files, the web, another agent’s notes.', source: 'paseo' },
  { id: 'voice', name: ROLE_NAMES.voice, about: 'Answers the phone and reads your replies aloud.', source: 'hermes' },
];

export const ROLE_BY_ID: Record<RoleId, TeamRole> = Object.fromEntries(ROLES.map((r) => [r.id, r])) as Record<RoleId, TeamRole>;

/** Part of the tile's accessible name: "Coder, needs you". */
export const ROLE_STATE_LABEL: Record<RoleState, string> = {
  idle: 'idle',
  working: 'working',
  needs: 'needs you',
  stuck: 'stuck',
  finished: 'finished',
};

export function roleTileName(role: Role, state: RoleState): string {
  return `${role.name}, ${ROLE_STATE_LABEL[state]}`;
}

/** Something waiting on you outranks everything else a tile can show. */
const ROLE_STATE_RANK: Record<RoleState, number> = { idle: 0, finished: 1, working: 2, stuck: 3, needs: 4 };

/**
 * A role's badge from what the app already knows: something waiting on you beats
 * work in progress, which beats idle. A broken chat reads as stuck.
 */
export function roleStates(
  conversations: Iterable<ConversationSummary>,
  approvals: Iterable<Approval>,
): Record<RoleId, RoleState> {
  const waiting = new Set<Source>();
  for (const approval of approvals) waiting.add(approval.source);

  const bySource: Record<Source, RoleState> = { hermes: 'idle', paseo: 'idle' };
  const raise = (source: Source, state: RoleState) => {
    if (ROLE_STATE_RANK[state] > ROLE_STATE_RANK[bySource[source]]) bySource[source] = state;
  };
  for (const source of waiting) raise(source, 'needs');
  for (const conversation of conversations) {
    if (conversation.status === 'needs_approval' || conversation.pendingApprovals > 0) raise(conversation.source, 'needs');
    else if (conversation.status === 'error') raise(conversation.source, 'stuck');
    else if (conversation.status === 'running') raise(conversation.source, 'working');
  }

  return Object.fromEntries(ROLES.map((role) => [role.id, bySource[role.source]])) as Record<RoleId, RoleState>;
}
