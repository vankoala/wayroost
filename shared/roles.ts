// Roles people see (Manager, Agent, Coder…) instead of engines,
// and which role a conversation belongs to. Pure, so the web app's approval cards
// and the desktop app's toasts name the same role.
import type { ConversationSummary, Source } from './protocol.js';

export type RoleId = 'manager' | 'agent' | 'coder' | 'reviewer' | 'scout' | 'voice';

export interface Role {
  id: RoleId;
  /** What people see: "Coder", never "Paseo" (or the agent's own label when no role fits). */
  name: string;
}

export const ROLE_NAMES: Record<RoleId, string> = {
  manager: 'Manager',
  agent: 'Agent',
  coder: 'Coder',
  reviewer: 'Reviewer',
  scout: 'Scout',
  voice: 'Voice',
};

// ---- Which role a conversation belongs to (approval cards) --------------------

const REVIEWER = /\breview/i;
const SCOUT = /\b(scout|research)/i;
const VOICE = /\b(voice|phone|call)\b/i;
/** Coding agents Paseo runs, and the coder role providers. */
const CODER = /\b(claude code|claude|codex|opencode|pi|coder|aider|gemini|cursor|amp|goose|copilot)\b/i;

const role = (id: RoleId): Role => ({ id, name: ROLE_NAMES[id] });

/**
 * A conversation's role, from the backend that runs it and which agent it is.
 * When neither says, the agent's own label stands in, on the Agent tile.
 */
export function roleOf(source: Source, conversation?: ConversationSummary): Role {
  if (source === 'hermes') {
    // Hermes' own chats are the manager; a delegate_task run works for it.
    return role(conversation?.subagent ? 'agent' : 'manager');
  }
  if (!conversation) return role('agent');
  // Hermes running inside Paseo is a helper started by someone else.
  if (conversation.hermesInPaseo) return role('agent');
  const label = conversation.agentLabel?.trim() ?? '';
  if (REVIEWER.test(label)) return role('reviewer');
  if (SCOUT.test(label)) return role('scout');
  if (VOICE.test(label)) return role('voice');
  if (CODER.test(label)) return role('coder');
  return label ? { id: 'agent', name: label } : role('agent');
}

/** Engine words, for Details only: "Hermes", "Paseo · Claude Code". */
export function engineOf(source: Source, conversation?: ConversationSummary): string {
  const label = conversation?.agentLabel?.trim();
  if (source === 'hermes') return label ? `Hermes · ${label}` : 'Hermes';
  if (conversation?.hermesInPaseo) return 'Hermes in Paseo';
  return label ? `Paseo · ${label}` : 'Paseo';
}
