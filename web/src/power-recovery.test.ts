// @vitest-environment jsdom
import { act as renderAct, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, PowerStatus } from '../../shared/protocol';
import type { ActionDetail } from '../../shared/supervisor';

const device: DeviceInfo = { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 };
const healthy: PowerStatus = { running: true, sentence: 'Demo stopped.', presence: [], status: {
  overall: 'down', sentence: 'Demo stopped.', at: 10, components: [
    { id: 'coder', name: 'Second model', state: 'down', sentence: 'Demo stopped.', actions: ['start'] },
  ],
} };
const stale: PowerStatus = { ...healthy, sentence: 'Demo running.', status: {
  ...healthy.status!, overall: 'ok', sentence: 'Demo running.', at: 1, components: [
    { id: 'coder', name: 'Second model', state: 'up', sentence: 'Demo running.', actions: ['restart', 'stop'] },
  ],
} };
const running: ActionDetail = { id: 'demo-action', verb: 'restart', target: 'coder', state: 'running', caller: 'demo', startedAt: 1, lines: [] };
const done: ActionDetail = { ...running, state: 'done', endedAt: 2, result: 'Demo apparent success.', lines: ['Demo command finished.'] };
const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo audit error.'] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
let root: Root;
let container: HTMLDivElement;
let power: typeof import('./power');
let store: typeof import('./store');
let current: import('./power').Power;
let fetch: ReturnType<typeof vi.fn>;
let status: PowerStatus;
let detail: ActionDetail;
let hidden: boolean;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  store = await import('./store');
  store.setState((s) => ({ ...s, device, socket: 'open' }));
  status = healthy;
  detail = running;
  fetch = vi.fn(async (path: string) => path === '/api/power/actions/demo-action' ? json(detail) : json(status));
  vi.stubGlobal('fetch', fetch);
  power = await import('./power');
  const { StatusPage } = await import('./pages/StatusPage');
  function Watcher() { current = power.usePower(); return null; }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await renderAct(async () => root.render(h('div', null, h(Watcher), h(StatusPage, { onConfirm: vi.fn() }))));
});
afterEach(async () => {
  await renderAct(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const recovery = async (boundary: string) => {
  if (boundary === 'reconnect') {
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'closed' })));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
  } else if (boundary === 'visibility') {
    await renderAct(async () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  } else if (boundary === 'refresh') await renderAct(async () => current.refresh());
  else if (boundary === 're-pair') await renderAct(async () => {
    store.markUnpaired();
    store.setState((s) => ({ ...s, unpaired: false, device: { ...device, id: 'demo-new-desktop' } }));
  });
  else {
    status = { running: false, sentence: 'Demo offline.', presence: [] };
    await renderAct(async () => power.load());
    status = healthy;
    await renderAct(async () => power.load());
  }
};

describe('socket snapshots only schedule HTTP status reads', () => {
  it.each(['after', 'during'])('keeps newer HTTP status when a stale socket snapshot arrives %s a read', async (timing) => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    let read: Promise<void> | undefined;
    if (timing === 'during') read = power.load();
    const count = fetch.mock.calls.filter(([path]) => path === '/api/power').length;
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: stale }));
    expect(current.status).toEqual(healthy.status);
    expect(container.querySelector('.power-actions')?.textContent).toBe('Start');
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power').length).toBeGreaterThanOrEqual(count + (timing === 'after' ? 1 : 0));
    await renderAct(async () => { pending.resolve(json(healthy)); await read; });
    expect(current.status).toEqual(healthy.status);
    expect(container.querySelector('.power-actions')?.textContent).toBe('Start');
  });

  it('does not learn action IDs, output, presence or outages from a socket snapshot', async () => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: {
      ...stale, status: { ...stale.status!, running: done }, presence: [{ device: 'demo-phone', kind: 'phone', state: 'active', at: 1 }],
    } }));
    expect(current.status).toEqual(healthy.status);
    expect(current.action).toBeNull();
    expect(current.presence).toEqual([]);
    expect(fetch.mock.calls.some(([path]) => path === '/api/power/actions/demo-action')).toBe(false);
    await renderAct(async () => pending.resolve(json(healthy)));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: { running: false, sentence: 'Demo stale outage.', presence: [] } }));
    expect(current.unavailable).toBe(false);
    expect(current.sentence).toBe(healthy.sentence);
  });

  it('uses HTTP request order even when the latest snapshot timestamp decreases', async () => {
    status = stale;
    await renderAct(async () => power.load());
    expect(current.status).toEqual(stale.status);
    expect(container.querySelector('.power-actions')?.textContent).toBe('RestartStop');
  });

  it('coalesces a socket burst into one pending status read and a fresh follow-up', async () => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    const count = fetch.mock.calls.length;
    await renderAct(async () => {
      for (let i = 0; i < 100; i += 1) power.applyPowerEvent({ type: 'power_status', power: stale });
    });
    expect(fetch.mock.calls.length).toBe(count + 1);
    await renderAct(async () => pending.resolve(json(healthy)));
    expect(fetch.mock.calls.length).toBe(count + 2);
    expect(current.status).toEqual(healthy.status);
  });
});

describe('recovery discards pending reads for every resource', () => {
  it.each(['reconnect', 'visibility', 'refresh', 'supervisor'].flatMap((boundary) => [false, true].flatMap((cached) => ['before', 'after'].map((timing) => [boundary, cached, timing] as const))))
    ('refetches a pending action after %s with running data cached: %s, old response arrives %s the fresh read', async (boundary, cached, timing) => {
      if (cached) await renderAct(async () => power.actionLines(running.id));
      const pending = deferred();
      const newest = deferred();
      fetch.mockImplementationOnce(() => pending.promise);
      const old = power.actionLines(running.id);
      let correctedReads = 0;
      detail = failed;
      fetch.mockImplementation(async (path: string) => {
        if (path === '/api/power/actions/demo-action') { correctedReads += 1; return newest.promise; }
        return json(status);
      });
      await recovery(boundary);
      if (timing === 'after') await renderAct(async () => newest.resolve(json(failed)));
      await renderAct(async () => { pending.resolve(json(done)); await old; });
      expect(current.result).not.toBe(done.result);
      expect(container.textContent).not.toContain(done.result);
      expect(correctedReads).toBeGreaterThan(0);
      await renderAct(async () => newest.resolve(json(failed)));
      expect(current.completed).toEqual([failed]);
      expect(current.result).toBe(failed.result);
      const count = fetch.mock.calls.length;
      await renderAct(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(current.result).toBe(failed.result);
      expect(fetch.mock.calls.slice(count).every(([path]) => path === '/api/power')).toBe(true);
    });

  it.each(['reconnect', 'visibility', 'refresh', 're-pair'])('refetches pending status at %s and drops late success and failure', async (boundary) => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    const old = power.load();
    await recovery(boundary);
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power').length).toBeGreaterThanOrEqual(3);
    await renderAct(async () => { pending.resolve(json(stale)); await old; });
    expect(current.status).toEqual(healthy.status);
    const failure = deferred();
    fetch.mockImplementationOnce(() => failure.promise);
    const refused = power.load();
    await recovery(boundary);
    await renderAct(async () => { failure.resolve(json({}, 503)); await refused; });
    expect(current.status).toEqual(healthy.status);
    expect(current.unavailable).toBe(false);
  });

  it('retries a failed recovery read without accepting a delayed apparent success', async () => {
    await renderAct(async () => power.actionLines(running.id));
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    const old = power.actionLines(running.id);
    fetch.mockResolvedValueOnce(json({}, 503));
    await recovery('refresh');
    await renderAct(async () => { pending.resolve(json(done)); await old; });
    expect(current.result).not.toBe(done.result);
    detail = failed;
    await renderAct(async () => vi.advanceTimersByTimeAsync(1_200));
    expect(current.completed).toEqual([failed]);
  });
});
