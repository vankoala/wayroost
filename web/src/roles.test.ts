import { describe, expect, it } from 'vitest';
import type { Approval, ConversationStatus, ConversationSummary, Source } from '../../shared/protocol';
import { ROLES, roleStates, roleTileName, ROLE_BY_ID } from './roles';

// A role's badge in M1 comes from the chats its engine runs (see roles.ts). Fake chats,
// obviously fake ids.

const chat = (source: Source, status: ConversationStatus, pendingApprovals = 0): ConversationSummary => ({
  source,
  id: `${source}-chat-1`,
  title: 'Fake chat',
  status,
  updatedAt: 1,
  pendingApprovals,
});

const ask = (source: Source, kind: Approval['kind'] = 'permission'): Approval => ({
  id: `${source}-ask-1`,
  source,
  conversationId: `${source}-chat-1`,
  kind,
  title: 'Run a shell command',
  options: [{ id: 'allow', label: 'Allow once', kind: 'allow' }],
  createdAt: 1,
});

describe('roleStates', () => {
  it('has a tile for each of the six roles, and each belongs to one engine', () => {
    expect(ROLES.map((r) => r.id)).toEqual(['manager', 'agent', 'coder', 'reviewer', 'scout', 'voice']);
    expect(ROLES.every((r) => r.source === 'hermes' || r.source === 'paseo')).toBe(true);
    expect(roleTileName(ROLE_BY_ID.coder!, 'idle')).toBe('Coder, idle');
    expect(roleTileName(ROLE_BY_ID.manager!, 'needs')).toBe('Manager, needs you');
  });

  it('leaves the tiles idle with nothing going on', () => {
    expect(Object.values(roleStates([], [])).every((state) => state === 'idle')).toBe(true);
  });

  it('shows the roles of the engine that is working, and only those', () => {
    const states = roleStates([chat('paseo', 'running')], []);
    expect(states.coder).toBe('working');
    expect(states.reviewer).toBe('working');
    expect(states.manager).toBe('idle');
    expect(states.voice).toBe('idle');
  });

  it('puts "needs you" above work in progress', () => {
    const states = roleStates([chat('paseo', 'running'), chat('hermes', 'running')], [ask('hermes')]);
    expect(states.agent).toBe('needs');
    expect(states.coder).toBe('working');
  });

  it('counts a chat that holds an approval even when its status says otherwise', () => {
    expect(roleStates([chat('hermes', 'idle', 2)], []).agent).toBe('needs');
  });

  it('reads a broken chat as stuck, and a waiting answer still outranks it', () => {
    expect(roleStates([chat('hermes', 'error')], []).voice).toBe('stuck');
    expect(roleStates([chat('hermes', 'error')], [ask('hermes', 'question')]).voice).toBe('needs');
  });
});
