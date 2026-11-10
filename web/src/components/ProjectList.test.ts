// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../../shared/protocol';
import { groupByProject, projectTree } from '../projects';
import { ProjectList } from './ProjectList';
import { moveChat } from '../api';
import { CHAT_DRAG_TYPE, revealMovedFolder } from '../move';

let storedConversations: Record<string, ConversationSummary> = {};

vi.mock('../store', () => ({
  useStore: (select: (s: { conversations: object }) => unknown) => select({ conversations: storedConversations }),
  convKey: (source: string, id: string) => `${source}:${id}`,
  toast: vi.fn(),
}));
vi.mock('../api', () => ({ api: {}, dropThreads: vi.fn(), reportTidy: vi.fn(), moveChat: vi.fn() }));

const base = '/home/me/research';
const chat = (path: string, status: ConversationSummary['status'] = 'idle'): ConversationSummary => ({
  source: 'hermes', id: path, title: `Chat at ${path}`, project: { path, name: '' }, status, updatedAt: 1, pendingApprovals: 0,
});

describe('collapsible project folders', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onNewIn = vi.fn();
  const needsYou = (c: ConversationSummary) => c.status === 'needs_approval';
  const draw = async (chats: ConversationSummary[]) => {
    storedConversations = Object.fromEntries(chats.map((c) => [`${c.source}:${c.id}`, c]));
    await act(async () => root.render(createElement(ProjectList, { groups: projectTree(groupByProject(chats, needsYou)), activeKey: null, needsYou, onNewIn })));
  };
  const section = (name: string) => host.querySelector(`section[aria-label="${name}"]`)!;
  const toggle = (name: string) => section(name).querySelector<HTMLButtonElement>('.project-toggle')!;
  const click = async (button: HTMLButtonElement) => { await act(async () => button.click()); };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    onNewIn.mockClear();
    vi.mocked(moveChat).mockClear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('folds subfolders independently and remembers both open and closed paths across remounts', async () => {
    const chats = [chat(`${base}/coverage/alpha`), chat(`${base}/coverage/beta`), chat(`${base}/desk`)];
    await draw(chats);
    expect(toggle('research').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('coverage').getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('alpha');
    await click(toggle('coverage'));
    expect(toggle('alpha').getAttribute('aria-expanded')).toBe('false');
    await click(toggle('alpha'));
    expect(section('alpha').textContent).toContain(`Chat at ${base}/coverage/alpha`);
    await click(toggle('beta')); // leave this leaf open while its parent is folded
    await click(toggle('coverage'));
    await act(async () => root.unmount());
    root = createRoot(host);
    await draw(chats);
    expect(toggle('coverage').getAttribute('aria-expanded')).toBe('false');
    await click(toggle('coverage'));
    expect(toggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('beta').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('desk').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens ancestors of running or waiting chats by default and respects an explicit collapse', async () => {
    const chats = [chat(`${base}/coverage/alpha`, 'running'), chat(`${base}/coverage/beta`, 'needs_approval'), chat(`${base}/desk`)];
    await draw(chats);
    expect(toggle('coverage').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('beta').getAttribute('aria-expanded')).toBe('true');
    await click(toggle('coverage'));
    await draw(chats);
    expect(toggle('coverage').getAttribute('aria-expanded')).toBe('false');
  });

  it('offers new chat on synthetic paths, archive only on real groups, and shows a real parent’s chats', async () => {
    await draw([chat(base), chat(`${base}/coverage/alpha`, 'running'), chat(`${base}/coverage/beta`)]);
    expect(section('research').textContent).toContain(`Chat at ${base}`);
    expect(section('research').querySelector('button[aria-label="Archive research"]')).not.toBeNull();
    expect(section('coverage').querySelector('button[aria-label="Archive coverage"]')).toBeNull();
    await click(section('coverage').querySelector<HTMLButtonElement>('button[aria-label="New conversation in coverage"]')!);
    expect(onNewIn).toHaveBeenCalledWith(`${base}/coverage`);
  });

  const drag = async (element: Element, type: string, data: { types: string[]; setData: (type: string, value: string) => void; getData: (type: string) => string }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    await act(async () => { element.dispatchEvent(event); });
    return event;
  };
  const transfer = (types: string[] = []) => {
    const values = new Map<string, string>();
    return { types, setData: (type: string, value: string) => { values.set(type, value); if (!types.includes(type)) types.push(type); },
      getData: (type: string) => values.get(type) ?? '' };
  };

  it('drags only idle Hermes rows and drops onto synthetic and deeply nested headers', async () => {
    const source = chat(`${base}/desk`);
    const chats = [source, chat(`${base}/coverage/alpha`), chat(`${base}/coverage/beta`),
      { ...chat(`${base}/busy`, 'running'), id: 'busy' }, { ...chat(`${base}/approval`, 'needs_approval'), id: 'approval' },
      { ...chat(`${base}/paseo`), id: 'paseo', source: 'paseo' as const }];
    await draw(chats);
    await click(toggle('desk'));
    const row = section('desk').querySelector<HTMLButtonElement>('.row')!;
    expect(row.draggable).toBe(true);
    expect(section('busy').querySelector<HTMLButtonElement>('.row')!.draggable).toBe(false);
    expect(section('approval').querySelector<HTMLButtonElement>('.row')!.draggable).toBe(false);
    await click(toggle('paseo'));
    expect(section('paseo').querySelector<HTMLButtonElement>('.row')!.draggable).toBe(false);
    const data = transfer();
    await drag(row, 'dragstart', data);
    expect(data.getData(CHAT_DRAG_TYPE)).toBe(`hermes:${source.id}`);
    const head = section('coverage').querySelector('.project-head')!;
    expect((await drag(head, 'dragover', data)).defaultPrevented).toBe(true);
    expect(head.classList.contains('move-target')).toBe(true);
    await drag(head, 'drop', data);
    expect(moveChat).toHaveBeenCalledWith(source, `${base}/coverage`);

    await click(toggle('coverage'));
    await drag(row, 'dragstart', data);
    const deepHead = section('alpha').querySelector('.project-head')!;
    expect((await drag(deepHead, 'dragover', data)).defaultPrevented).toBe(true);
    await drag(deepHead, 'drop', data);
    expect(moveChat).toHaveBeenLastCalledWith(source, `${base}/coverage/alpha`);
  });

  it('ignores current-folder and file drops, and permits dragging out of Other chats', async () => {
    const other = { ...chat(base), id: 'other', project: undefined };
    await draw([chat(base), other]);
    const head = section('research').querySelector('.project-head')!;
    const row = section('research').querySelector('.row')!;
    const data = transfer();
    await drag(row, 'dragstart', data);
    expect((await drag(head, 'dragover', data)).defaultPrevented).toBe(false);
    await drag(head, 'drop', data);
    const files = transfer(['Files']);
    expect((await drag(head, 'dragover', files)).defaultPrevented).toBe(false);
    expect((await drag(head, 'drop', files)).defaultPrevented).toBe(false);
    expect(moveChat).not.toHaveBeenCalled();
    const otherHead = section('Other chats').querySelector('.project-head')!;
    await drag(section('Other chats').querySelector('.row')!, 'dragstart', data);
    expect((await drag(otherHead, 'dragover', data)).defaultPrevented).toBe(false);
    await drag(head, 'drop', data);
    expect(moveChat).toHaveBeenCalledWith(other, base);
  });

  it('opens a moved destination and its collapsed ancestors without a remount', async () => {
    await draw([chat(`${base}/coverage/alpha`), chat(`${base}/coverage/beta`), chat(`${base}/desk`)]);
    await click(toggle('research'));
    await act(async () => revealMovedFolder(`${base}/coverage/alpha`));
    expect(toggle('research').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('coverage').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('alpha').getAttribute('aria-expanded')).toBe('true');
  });
});
