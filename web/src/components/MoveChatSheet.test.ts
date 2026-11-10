// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../../shared/protocol';
import { api, moveChat } from '../api';
import { COLLAPSED_PROJECTS, EXPANDED_PROJECTS, revealMovedFolder } from '../move';
import { convKey, getState, setState } from '../store';
import { MoveChatSheet } from './MoveChatSheet';

vi.mock('../api', () => ({ api: { folderStatus: vi.fn() }, moveChat: vi.fn() }));
const base = '/home/me/research';
const chat = (id: string, path?: string): ConversationSummary => ({ source: 'hermes', id, title: `Invented ${id}`, status: 'idle',
  updatedAt: 1, pendingApprovals: 0, ...(path ? { project: { path, name: '' } } : {}) });
const current = chat('aaa', `${base}/coverage/alpha`);

describe('move folder picker', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const draw = async (c = current) => { await act(async () => root.render(createElement(MoveChatSheet, { conversation: c, onClose }))); };
  const button = () => host.querySelector<HTMLButtonElement>('.sheet-foot button')!;
  const input = () => host.querySelector<HTMLInputElement>('input')!;
  const choose = async (name: string) => {
    const option = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((o) => o.querySelector('.label div')?.textContent === name)!;
    await act(async () => option.click());
  };
  const checked = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
  const typePath = async (path: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), path);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.mocked(api.folderStatus).mockResolvedValue({ status: 'exists' });
    vi.mocked(moveChat).mockResolvedValue();
    onClose.mockClear();
    localStorage.clear();
    const chats = [current, chat('bbb', `${base}/coverage/beta`), chat('desk', `${base}/desk`), chat('other')];
    setState((s) => ({ ...s, conversations: Object.fromEntries(chats.map((c) => [convKey(c.source, c.id), c])) }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('lists real and synthetic folders in Projects order, indents by depth, marks current, and omits Other chats', async () => {
    await draw();
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(options.map((o) => o.querySelector('.label div')?.textContent)).toEqual(['research', 'coverage', 'alpha (current folder)', 'beta', 'desk']);
    expect(options.map((o) => o.style.paddingInlineStart)).toEqual(['16px', '36px', '56px', '56px', '36px']);
    expect(options[2]!.getAttribute('aria-checked')).toBe('true');
    expect(button().disabled).toBe(true);
    expect(host.textContent).not.toContain('Other chats');
  });

  it('checks a selected synthetic folder and moves only after it exists', async () => {
    await draw();
    await choose('coverage');
    expect(button().disabled).toBe(true);
    await checked();
    expect(api.folderStatus).toHaveBeenCalledWith(`${base}/coverage`);
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(moveChat).toHaveBeenCalledWith(current, `${base}/coverage`);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets an unfiled chat choose a folder without offering Other chats as a destination', async () => {
    const unfiled = chat('other');
    await draw(unfiled);
    expect(host.textContent).toContain('Current folder: Other chats');
    expect([...host.querySelectorAll('[role="radio"]')].some((option) => option.textContent?.includes('Other chats'))).toBe(false);
    await choose('desk');
    await checked();
    await act(async () => button().click());
    expect(moveChat).toHaveBeenCalledWith(unfiled, `${base}/desk`);
  });

  it('checks a typed path, refuses missing folders, and does not offer creation', async () => {
    vi.mocked(api.folderStatus).mockResolvedValue({ status: 'missing' });
    await draw();
    await typePath('/home/me/missing');
    await checked();
    expect(api.folderStatus).toHaveBeenCalledWith('/home/me/missing');
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('already exists');
    expect(host.textContent).not.toContain('Create');
    expect(moveChat).not.toHaveBeenCalled();
    await typePath('/home/me/a/../b');
    await checked();
    expect(button().disabled).toBe(true);
    expect(api.folderStatus).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal, retains the picker and leaves collapse choices untouched', async () => {
    vi.mocked(moveChat).mockRejectedValue(new Error('Hermes refused the move'));
    localStorage.setItem(COLLAPSED_PROJECTS, JSON.stringify([base]));
    await draw();
    await choose('desk');
    await checked();
    await act(async () => button().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Hermes refused the move');
    expect(input().value).toBe(`${base}/desk`);
    expect(onClose).not.toHaveBeenCalled();
    expect(localStorage.getItem(COLLAPSED_PROJECTS)).toBe(JSON.stringify([base]));
  });

  it('disables moving when a chat becomes busy while the picker is open', async () => {
    await draw();
    await choose('desk');
    await checked();
    await draw({ ...current, status: 'running' });
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('finishes working');
  });

  it('shows a failure as a toast when the sheet closed before the reply arrived', async () => {
    let fail!: (err: Error) => void;
    vi.mocked(moveChat).mockReturnValue(new Promise<void>((_, reject) => { fail = reject; }));
    setState((s) => ({ ...s, toasts: [] }));
    await draw();
    await choose('coverage');
    await checked();
    await act(async () => button().click());
    await act(async () => root.render(null));
    await act(async () => { fail(new Error('This chat is no longer listed.')); });
    expect(getState().toasts.map((x) => x.text)).toEqual(['This chat is no longer listed.']);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a failure inline while the sheet is open', async () => {
    vi.mocked(moveChat).mockRejectedValue(new Error('Hermes refused the move.'));
    setState((s) => ({ ...s, toasts: [] }));
    await draw();
    await choose('coverage');
    await checked();
    await act(async () => button().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Hermes refused the move.');
    expect(getState().toasts).toEqual([]);
  });

  it('opens the destination and its ancestors, preserving unrelated collapse choices', () => {
    localStorage.setItem(COLLAPSED_PROJECTS, JSON.stringify([base, `${base}/coverage`, '/home/me/unrelated']));
    revealMovedFolder(`${base}/coverage/alpha`);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS)!)).toEqual(['/home/me/unrelated']);
    expect(JSON.parse(localStorage.getItem(EXPANDED_PROJECTS)!)).toEqual(expect.arrayContaining([base, `${base}/coverage`, `${base}/coverage/alpha`]));
  });
});
