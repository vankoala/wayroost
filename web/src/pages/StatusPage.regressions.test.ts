// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupervisorStatus } from '../../../shared/supervisor';
import { StatusPage } from './StatusPage';
import type { ActResult } from '../power';
import { setState } from '../store';

const mock = vi.hoisted(() => ({ act: vi.fn(), lines: vi.fn(), status: null as SupervisorStatus | null }));
vi.mock('../power', async (original) => ({
  ...await original<typeof import('../power')>(),
  actionLines: mock.lines,
  usePower: () => ({ status: mock.status, loaded: true, unavailable: false, sentence: mock.status?.sentence ?? null, presence: [], action: mock.status?.running ?? null, result: null, lines: ['Demo progress'], completed: [], refresh: vi.fn(), act: mock.act, actionGuard: () => () => true }),
}));
let root: Root;
let container: HTMLDivElement;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const click = async (text: string) => act(async () => button(text).click());
const key = async (key: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setState((s) => ({ ...s, device: { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 } }));
  mock.act.mockReset().mockResolvedValue({ kind: 'error', message: 'Demo fixture' });
  mock.lines.mockReset().mockResolvedValue(['Demo progress']);
  mock.status = {
    overall: 'ok', sentence: 'Everything is running.', at: 1,
    components: [{
      id: 'main-model', name: 'Main model', state: 'up', sentence: 'It is answering.', busy: true,
      actions: ['hold', 'restart', 'switch-model'],
      model: { live: 'demo-live', profiles: [
        { id: 'demo-live', name: 'Live fixture', gpus: [] },
        { id: 'demo-next', name: 'Next fixture', gpus: [] },
        { id: 'demo-other', name: 'Other fixture', gpus: [] },
      ] },
    }],
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(h(StatusPage, { onConfirm: vi.fn() })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('every power action uses its picker', () => {
  it.each([false, true])('keeps focus in the new card menu when ownership changes, reverse: %s', async (reverse) => {
    mock.status!.components.push({ id: 'coder', name: 'Second model', state: 'up', sentence: 'Ready.', actions: ['restart'] });
    await act(async () => root.render(h(StatusPage, { onConfirm: vi.fn() })));
    const triggers = [...container.querySelectorAll<HTMLButtonElement>('.power-actions button')].filter((b) => b.textContent === 'Restart');
    const [first, second] = reverse ? triggers.toReversed() : triggers;
    await act(async () => first!.click());
    await act(async () => second!.click());
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(container.querySelector('[role="menu"]')?.contains(document.activeElement)).toBe(true);
    await key('Escape');
    expect(document.activeElement).toBe(second);
  });

  it('asks when before a secondary restart posts', async () => {
    await click('Restart');
    expect(mock.act).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Restart');
    const whenIdle = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!;
    await act(async () => whenIdle.click());
    expect(mock.act).toHaveBeenCalledWith({ verb: 'restart', target: 'main-model', when: 'idle' });
  });

  it('asks for a profile and timing before a secondary model switch posts', async () => {
    await click('Switch model');
    expect(mock.act).not.toHaveBeenCalled();
    await click('Next fixture');
    expect(mock.act).not.toHaveBeenCalled();
    await click('Now');
    expect(mock.act).toHaveBeenCalledWith({ verb: 'switch-model', target: 'main-model', profile: 'demo-next', when: 'now' });
  });

  it('moves focus through stages, navigates items, and restores the trigger on Escape', async () => {
    const trigger = button('Switch model');
    trigger.focus();
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Next fixture');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Other fixture');
    await key('Home');
    expect(document.activeElement?.textContent).toBe('Next fixture');
    await click('Next fixture');
    expect(document.activeElement?.textContent).toBe('Now');
    await key('End');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await key('ArrowUp');
    expect(document.activeElement?.textContent).toContain('When idle');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Now');
    await key('Escape');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the secondary trigger when Cancel closes the picker', async () => {
    const trigger = button('Restart');
    trigger.focus();
    await click('Restart');
    await click('Cancel');
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['Restart', 'Switch model'])('restores the %s trigger after a delayed request fails', async (action) => {
    let resolve!: (result: ActResult) => void;
    mock.act.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    const trigger = button(action);
    trigger.focus();
    await click(action);
    if (action === 'Switch model') await click('Next fixture');
    await click('Now');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
    await act(async () => resolve({ kind: 'error', message: 'Demo request failed' }));
    expect(trigger.disabled).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['menu stays open', 'menu closes', 'other control'])('does not restore stale request focus after another interaction: %s', async (interaction) => {
    let resolve!: (result: ActResult) => void;
    mock.act.mockImplementationOnce(() => new Promise<ActResult>((done) => { resolve = done; }));
    mock.status!.components.push({ id: 'coder', name: 'Second model', state: 'up', sentence: 'Ready.', actions: ['restart'] });
    await act(async () => root.render(h(StatusPage, { onConfirm: vi.fn() })));
    await click('Restart');
    await click('Now');
    let owner: Element;
    if (interaction === 'other control') {
      owner = container.querySelector('.power-details summary')!;
      await act(async () => (owner as HTMLElement).focus());
    } else {
      const second = container.querySelectorAll<HTMLButtonElement>('.power-card')[1]!.querySelector<HTMLButtonElement>('.power-actions button')!;
      await act(async () => second.click());
      if (interaction === 'menu closes') await click('Cancel');
      owner = document.activeElement!;
    }
    await act(async () => resolve({ kind: 'error', message: 'Demo request failed' }));
    expect(document.activeElement).toBe(owner);
  });
});

describe('progress polling visibility', () => {
  const advance = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
  const progress = async () => {
    mock.status!.running = { id: 'demo-progress', verb: 'restart', target: 'main-model', state: 'running', caller: 'demo', startedAt: 1 };
    await act(async () => root.render(h(StatusPage, { onConfirm: vi.fn() })));
    await click('Show progress');
  };

  it('suspends hidden progress requests, refreshes on return, and cleans up on close', async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const visibility = async (value: boolean) => act(async () => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await progress();
    expect(mock.lines).toHaveBeenCalledTimes(1);
    await advance(1_500);
    expect(mock.lines).toHaveBeenCalledTimes(2);
    await visibility(true);
    await advance(15_000);
    expect(mock.lines).toHaveBeenCalledTimes(2);
    await visibility(false);
    expect(mock.lines).toHaveBeenCalledTimes(3);
    await advance(1_500);
    expect(mock.lines).toHaveBeenCalledTimes(4);
    await click('Hide progress');
    await visibility(true);
    await visibility(false);
    await advance(15_000);
    expect(mock.lines).toHaveBeenCalledTimes(4);
  });

  it('waits for visibility before the first progress request and cleans up on unmount', async () => {
    vi.useFakeTimers();
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await progress();
    await advance(15_000);
    expect(mock.lines).not.toHaveBeenCalled();
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mock.lines).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(15_000);
    expect(mock.lines).toHaveBeenCalledTimes(1);
  });
});
