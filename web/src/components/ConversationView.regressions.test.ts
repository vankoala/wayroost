// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationView } from './ConversationView';
import { loadConversation } from '../api';
import { getState, setState } from '../store';
import { navigate } from '../router';
import type { ConversationSummary } from '../../../shared/protocol';

const fixture = vi.hoisted(() => ({ tidy: vi.fn() }));
vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  loadConversation: vi.fn(),
  api: { archiveThreads: fixture.tidy, deleteThreads: fixture.tidy },
}));
vi.mock('../events', () => ({ watchConversation: vi.fn(), unwatchConversation: vi.fn() }));
vi.mock('./Composer', () => ({ Composer: () => null }));
vi.mock('./Timeline', () => ({ Timeline: () => null }));
vi.mock('./Controls', () => ({ ControlsStrip: () => null }));
vi.mock('./Approvals', () => ({ ApprovalDock: () => null }));

let root: Root;
let container: HTMLDivElement;
const initial = getState();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.tidy.mockReset().mockResolvedValue({ done: 1, failed: [] });
  setState(() => ({ ...initial, conversations: {
    'hermes:demo-thread': { source: 'hermes', id: 'demo-thread', title: 'Demo thread', status: 'idle', updatedAt: 1, pendingApprovals: 0 },
  } }));
  history.replaceState(null, '', '/chats');
  navigate('/c/hermes/demo-thread');
  navigate('/c/hermes/demo-thread?filter=working');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(h(ConversationView, { source: 'hermes', id: 'demo-thread', offline: false, onNew: vi.fn() })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const click = async (text: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;
  await act(async () => button.click());
};

describe('removing the open thread', () => {
  it.each(['archive', 'delete'])('opens a valid inbox after %s, even with duplicate thread history', async (verb) => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!.click());
    if (verb === 'archive') await click('Archive');
    else {
      await click('Delete…');
      await click('Delete');
    }
    expect(fixture.tidy).toHaveBeenCalledWith([{ source: 'hermes', id: 'demo-thread' }]);
    expect(getState().conversations['hermes:demo-thread']).toBeUndefined();
    expect(location.pathname + location.search).toBe('/chats?filter=working');
  });

  it('keeps the thread open when its archive failed', async () => {
    fixture.tidy.mockResolvedValue({ done: 0, failed: [{ source: 'hermes', id: 'demo-thread', error: 'Demo failure' }] });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!.click());
    await click('Archive');
    expect(location.pathname).toBe('/c/hermes/demo-thread');
    expect(getState().conversations['hermes:demo-thread']).toBeDefined();
  });
});

describe('related-thread filters', () => {
  it('uses a changed filter without remounting the open thread', async () => {
    await act(async () => setState((s) => ({ ...s, conversations: { ...s.conversations,
      'paseo:demo-child': {
        source: 'paseo', id: 'demo-child', title: 'Demo child', status: 'idle', updatedAt: 1, pendingApprovals: 0,
        parent: { source: 'hermes', id: 'demo-thread' },
      },
    } })));
    const link = container.querySelector<HTMLButtonElement>('.links-bar button')!;
    await act(async () => navigate('/c/hermes/demo-thread?filter=attention', { replace: true }));
    expect(container.querySelector('.links-bar button')).toBe(link);
    await act(async () => link.click());
    expect(location.pathname + location.search).toBe('/c/paseo/demo-child?filter=attention');
  });

  it.each(['parent', 'started by', 'child', 'read-only parent'].flatMap((link) => ['working', 'all'].map((filter) => ({ link, filter }))))(
    'preserves $filter through the $link link', async ({ link, filter }) => {
      const related: ConversationSummary = {
        source: 'paseo', id: 'demo-related', title: 'Demo related thread', status: 'running', updatedAt: 1, pendingApprovals: 0,
      };
      await act(async () => {
        setState((s) => {
          const thread = { ...s.conversations['hermes:demo-thread']! };
          if (link === 'child') related.parent = { source: thread.source, id: thread.id };
          else if (link === 'started by') thread.startedBy = { source: related.source, id: related.id, title: related.title };
          else thread.parent = { source: related.source, id: related.id };
          if (link === 'read-only parent') thread.subagent = true;
          return { ...s, conversations: { 'hermes:demo-thread': thread, 'paseo:demo-related': related } };
        });
        navigate('/c/hermes/demo-thread' + (filter === 'all' ? '' : '?filter=' + filter), { replace: true });
      });
      const selector = link === 'read-only parent' ? '.readonly-bar button' : '.links-bar button';
      await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
      expect(location.pathname + location.search).toBe('/c/paseo/demo-related' + (filter === 'all' ? '' : '?filter=' + filter));
    },
  );
});

it('activates a shadow chat only after Open live chat is clicked', async () => {
  vi.mocked(loadConversation).mockClear();
  await act(async () => setState(s => ({ ...s, details: { ...s.details, 'hermes:demo-thread': { status: 'ready', items: [], needsOpen: true } } })));
  expect(loadConversation).not.toHaveBeenCalled();
  await click('Open live chat');
  expect(loadConversation).toHaveBeenCalledWith('hermes', 'demo-thread', true);
});
