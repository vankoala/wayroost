// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PowerStatus } from '../../shared/protocol';

let root: Root;
let container: HTMLDivElement;
let hidden: boolean;
const status: PowerStatus = { running: true, status: { overall: 'ok', sentence: 'Demo power', components: [], at: 1 }, sentence: 'Demo power', presence: [] };
const fetch = vi.fn();

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  const { setState } = await import('./store');
  setState((s) => ({ ...s, device: { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 } }));
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  fetch.mockReset().mockResolvedValue(new Response(JSON.stringify(status)));
  vi.stubGlobal('fetch', fetch);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const visibility = async (value: boolean) => act(async () => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
});
const mount = async () => {
  const { usePower } = await import('./power');
  function Watcher() { usePower(); return null; }
  await act(async () => root.render(h('div', null, h(Watcher), h(Watcher))));
};
const advance = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe('shared power polling and visibility', () => {
  it('clears power data and stops polling immediately on a stalled 401', async () => {
    await mount();
    const { getState } = await import('./store');
    const { applyPowerEvent, powerSnapshot } = await import('./power');
    expect(powerSnapshot()).toMatchObject({ sentence: 'Demo power' });
    const unpaired = vi.fn();
    window.wayroostTray = { update: vi.fn() };
    fetch.mockResolvedValue(new Response(new ReadableStream(), { status: 401 }));
    await advance(5000);
    expect(getState().sessionExpired).toBe(true);
    expect(powerSnapshot()).toBeNull();
    applyPowerEvent({ type: 'power_status', power: status });
    expect(powerSnapshot()).toBeNull();
    await visibility(true); await visibility(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(getState().unpaired).toBe(true);
    expect(unpaired).not.toHaveBeenCalled();
    await advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    delete window.wayroostTray;
  });
  it('suspends requests while hidden and immediately refreshes once on return', async () => {
    await mount();
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await visibility(true);
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await visibility(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => root.render(null));
    await visibility(true);
    await visibility(false);
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('waits for visibility before the initial request', async () => {
    hidden = true;
    await mount();
    await advance(15_000);
    expect(fetch).not.toHaveBeenCalled();
    await visibility(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not resume polling when a request finishes after the tab is hidden', async () => {
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    await mount();
    await visibility(true);
    await act(async () => resolve(new Response(JSON.stringify(status))));
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await visibility(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
