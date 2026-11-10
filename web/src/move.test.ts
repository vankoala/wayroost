// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../shared/protocol';
import { CHAT_DRAG_TYPE, COLLAPSED_PROJECTS, canDropChat, moveDisabledReason, validMoveFolder } from './move';
import { moveChat } from './api';
import { applyEvent, getState, setState } from './store';

const chat: ConversationSummary = { source: 'hermes', id: 'chat-1', title: 'Invented chat', status: 'idle', pendingApprovals: 0, updatedAt: 1,
  project: { path: '/home/me/old', name: 'old' } };
describe('chat drag destinations', () => {
  it('accepts a custom Hermes drag onto any valid different folder, including synthetic ancestors', () => {
    expect(canDropChat([CHAT_DRAG_TYPE], chat, '/home/me/new')).toBe(true);
    expect(canDropChat([CHAT_DRAG_TYPE], chat, '/home/me/research')).toBe(true);
    expect(canDropChat([CHAT_DRAG_TYPE], { ...chat, project: undefined }, '/home/me/new')).toBe(true);
  });
  it('leaves file and external drops alone and excludes current folder and Other chats', () => {
    for (const types of [['Files'], ['text/plain'], [CHAT_DRAG_TYPE, 'Files'], []]) {
      expect(canDropChat(types, chat, '/home/me/new')).toBe(false);
    }
    expect(canDropChat([CHAT_DRAG_TYPE], undefined, '/home/me/new')).toBe(false);
    expect(canDropChat([CHAT_DRAG_TYPE], chat, chat.project!.path)).toBe(false);
    expect(canDropChat([CHAT_DRAG_TYPE], chat, null)).toBe(false);
  });
  it('excludes Paseo, sub-agents, running chats and approvals with a reason', () => {
    for (const c of [{ ...chat, source: 'paseo' as const }, { ...chat, subagent: true },
      { ...chat, status: 'running' as const }, { ...chat, status: 'needs_approval' as const }, { ...chat, pendingApprovals: 1 }]) {
      expect(moveDisabledReason(c)).toBeTruthy();
      expect(canDropChat([CHAT_DRAG_TYPE], c, '/home/me/new')).toBe(false);
    }
  });
  it('requires canonical non-bare paths without traversal or NUL', () => {
    for (const path of ['/', '/home', '/root', '/home/me', '/home/me/a/../b', '/home/me/./b', '/home/me/a/', '/home//me/a', 'relative', '/home/me/a\0b', '/home/me/a..b']) {
      expect(validMoveFolder(path), path).toBe(false);
    }
    expect(validMoveFolder('/home/me/project')).toBe(true);
  });
});

describe('move request and confirmation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const setup = () => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem(COLLAPSED_PROJECTS, JSON.stringify(['/home/me/new']));
    setState((s) => ({ ...s, conversations: { 'hermes:chat-1': chat }, toasts: [] }));
  };
  it('updates the confirmed summary, opens the destination and confirms success', async () => {
    setup();
    const moved = { ...chat, project: { path: '/home/me/new', name: 'new' } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ conversation: moved }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await moveChat(chat, '/home/me/new');
    expect(fetch).toHaveBeenCalledWith('/api/threads/move', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ thread: { source: chat.source, id: chat.id }, cwd: '/home/me/new' }) }));
    expect(getState().conversations['hermes:chat-1']).toEqual(moved);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS)!)).toEqual([]);
    expect(getState().toasts.at(-1)?.text).toBe('Chat moved to folder.');
  });
  it('keeps the listing and folder preferences unchanged on refusal', async () => {
    setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Hermes refused' }), { status: 424 })));
    await expect(moveChat(chat, '/home/me/new')).rejects.toThrow('Hermes refused');
    expect(getState().conversations['hermes:chat-1']).toBe(chat);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS)!)).toEqual(['/home/me/new']);
    expect(getState().toasts).toEqual([]);
  });

  it.each([false, true])('handles a removal during a delayed move (restored before reply: %s)', async (restored) => {
    setup();
    const moved = { ...chat, project: { path: '/home/me/new', name: 'new' } };
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const outcome = moveChat(chat, '/home/me/new').catch((error: unknown) => error);
    applyEvent({ type: 'conversation_removed', source: chat.source, id: chat.id });
    if (restored) applyEvent({ type: 'conversation_upsert', conversation: chat });
    release(Response.json({ conversation: moved }));
    if (restored) {
      expect(await outcome).toBeUndefined();
      expect(getState().conversations['hermes:chat-1']).toEqual(moved);
      expect(getState().toasts.map((t) => t.text)).toEqual(['Chat moved to folder.']);
      expect(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS)!)).toEqual([]);
    } else {
      expect(await outcome).toMatchObject({ status: 404, message: 'This Hermes chat is no longer listed. Refresh and try again.' });
      expect(getState().conversations['hermes:chat-1']).toBeUndefined();
      expect(getState().toasts).toEqual([]);
      expect(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS)!)).toEqual(['/home/me/new']);

      applyEvent({ type: 'conversation_upsert', conversation: chat });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ conversation: moved })));
      await moveChat(chat, '/home/me/new');
      expect(getState().conversations['hermes:chat-1']).toEqual(moved);
      expect(getState().toasts.map((t) => t.text)).toEqual(['Chat moved to folder.']);
    }
  });
});
