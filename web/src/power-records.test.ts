// @vitest-environment jsdom
import { act as renderAct, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, PowerStatus } from '../../shared/protocol';
import type { ActionDetail } from '../../shared/supervisor';

const device: DeviceInfo = { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 };
const first: ActionDetail = { id: 'demo-first', verb: 'restart', target: 'coder', state: 'running', caller: 'demo', startedAt: 1, lines: [] };
const second: ActionDetail = { ...first, id: 'demo-second', verb: 'hold', startedAt: 4 };
const healthy: PowerStatus = { running: true, sentence: 'Demo services are running.', presence: [],
  status: { overall: 'ok', sentence: 'Demo services are running.', at: 1, components: [] } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
let root: Root;
let container: HTMLDivElement;
let power: typeof import('./power');
let current: import('./power').Power;
let records: Map<string, ActionDetail>;
let fetch: ReturnType<typeof vi.fn>;
let status: PowerStatus;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  vi.useFakeTimers();
  const store = await import('./store');
  store.setState((s) => ({ ...s, device }));
  records = new Map([[first.id, { ...first }], [second.id, { ...second }]]);
  status = healthy;
  fetch = vi.fn(async (path: string) => path.startsWith('/api/power/actions/')
    ? json(records.get(decodeURIComponent(path.slice('/api/power/actions/'.length)))) : json(status));
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
const event = async (detail: ActionDetail) => renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
const reads = (id: string) => fetch.mock.calls.filter(([path]) => path === `/api/power/actions/${id}`);

describe('fetched power action records', () => {
  it.each(['event', 'accepted', 'snapshot'] as const)('shows no action summary from a %s before its record is fetched', async (source) => {
    const pending = deferred();
    const claimed = { ...first, state: 'done' as const, result: 'Demo event-only result.', lines: ['Demo event-only output.'] };
    fetch.mockImplementation(async (path: string) => {
      if (path === '/api/power/actions') return json({ action: claimed }, 202);
      if (path.startsWith('/api/power/actions/')) return pending.promise;
      return json({ ...healthy, status: { ...healthy.status!, running: claimed } });
    });
    if (source === 'event') await event(claimed);
    else if (source === 'accepted') await renderAct(async () => { await power.act({ verb: 'restart', target: 'coder' }); });
    else await renderAct(async () => power.load());
    expect(current.action).toBeNull();
    expect(current.completed).toEqual([]);
    expect(container.querySelector('.power-banner')).toBeNull();
    await renderAct(async () => pending.resolve(json(first)));
    expect(current.action?.state).toBe('running');
    expect(current.result).toBeNull();
    expect(current.lines).toEqual([]);
    expect(container.textContent).not.toContain(claimed.result);
  });

  it('tracks an unknown line-event ID and displays only fetched output', async () => {
    records.set(first.id, { ...first, lines: ['Demo fetched line.'] });
    await renderAct(async () => power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: 'Demo event-only line.' }));
    expect(reads(first.id)).toHaveLength(1);
    expect(current.action?.id).toBe(first.id);
    expect(current.lines).toEqual(['Demo fetched line.']);
  });

  it('coalesces 500 progress hints into one pending read and one follow-up with the latest fetched output', async () => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => {
      for (let i = 0; i < 500; i += 1) power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: `Demo event line ${i}.` });
    });
    expect(reads(first.id)).toHaveLength(1);
    expect(current.action).toBeNull();
    const final: ActionDetail = { ...first, state: 'failed', endedAt: 3, result: 'Demo final failure.', lines: ['Demo final output.'] };
    records.set(first.id, final);
    await renderAct(async () => pending.resolve(json({ ...first, lines: ['Demo stale output.'] })));
    expect(reads(first.id)).toHaveLength(2);
    expect(current.completed).toEqual([final]);
    expect(current.lines).toEqual(final.lines);
    expect(container.textContent).not.toContain('Demo stale output.');
    await renderAct(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(reads(first.id)).toHaveLength(2);
  });

  it('coalesces each burst independently while a follow-up read remains pending', async () => {
    const pending = deferred();
    const followUp = deferred();
    fetch.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => followUp.promise);
    const burst = async () => renderAct(async () => {
      for (let i = 0; i < 500; i += 1) power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: `Demo progress ${i}.` });
    });
    await burst();
    expect(reads(first.id)).toHaveLength(1);
    await renderAct(async () => pending.resolve(json(first)));
    expect(reads(first.id)).toHaveLength(2);
    await burst();
    await renderAct(async () => power.load());
    expect(reads(first.id)).toHaveLength(2);
    records.set(first.id, { ...first, lines: ['Demo latest fetched output.'] });
    await renderAct(async () => followUp.resolve(json({ ...first, lines: ['Demo superseded output.'] })));
    expect(reads(first.id)).toHaveLength(3);
    expect(current.lines).toEqual(['Demo latest fetched output.']);
  });

  it('keeps progress reads independent per ID and follows a rejected request with one coalesced read', async () => {
    let reject!: (error: Error) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((_resolve, fail) => { reject = fail; }));
    await renderAct(async () => {
      for (let i = 0; i < 500; i += 1) power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: 'Demo progress.' });
      power.applyPowerEvent({ type: 'power_line', actionId: second.id, line: 'Demo second progress.' });
    });
    expect(reads(first.id)).toHaveLength(1);
    expect(reads(second.id)).toHaveLength(1);
    expect(current.action?.id).toBe(second.id);
    const final: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo recovered.', lines: [] };
    records.set(first.id, final);
    await renderAct(async () => reject(new Error('Demo connection lost.')));
    expect(reads(first.id)).toHaveLength(2);
    expect(current.completed).toEqual([final]);
    expect(current.action?.id).toBe(second.id);
  });

  it('bounds terminal-hint bursts while letting a final read overtake pending progress', async () => {
    const pending = deferred();
    const terminal = deferred();
    fetch.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => terminal.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: 'Demo progress.' }));
    const final: ActionDetail = { ...first, state: 'failed', endedAt: 3, result: 'Demo fetched final.', lines: ['Demo fetched final output.'] };
    const hint: ActionDetail = { ...final, result: 'Demo event-only result.' };
    records.set(first.id, final);
    await renderAct(async () => {
      for (let i = 0; i < 500; i += 1) power.applyPowerEvent({ type: 'power_action', action: hint });
    });
    expect(reads(first.id)).toHaveLength(2);
    await renderAct(async () => terminal.resolve(json({ ...first, result: 'Demo superseded provisional.' })));
    expect(reads(first.id)).toHaveLength(3);
    expect(current.completed).toEqual([final]);
    await renderAct(async () => pending.resolve(json(first)));
    expect(current.completed).toEqual([final]);
    expect(container.textContent).not.toContain('Demo event-only result.');
  });

  it('defers the coalesced follow-up while hidden and resumes once on visibility return', async () => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => {
      for (let i = 0; i < 500; i += 1) power.applyPowerEvent({ type: 'power_line', actionId: first.id, line: 'Demo progress.' });
    });
    expect(reads(first.id)).toHaveLength(1);
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => document.dispatchEvent(new Event('visibilitychange')));
    await renderAct(async () => pending.resolve(json(first)));
    expect(reads(first.id)).toHaveLength(1);
    expect(current.action).toBeNull();
    records.set(first.id, { ...first, state: 'done', result: 'Demo completed while hidden.', lines: [] });
    await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads(first.id)).toHaveLength(2);
    expect(current.result).toBe('Demo completed while hidden.');
  });

  it('polls running records with provisional results and stops only after fetching final result and lines', async () => {
    records.set(first.id, { ...first, result: 'Demo provisional result.' });
    await event(first);
    const final: ActionDetail = { ...first, state: 'failed', endedAt: 3, result: 'Demo final result.', lines: ['Demo final line.'] };
    records.set(first.id, final);
    await renderAct(async () => vi.advanceTimersByTimeAsync(1_200));
    expect(current.completed).toEqual([final]);
    const count = reads(first.id).length;
    await renderAct(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(reads(first.id)).toHaveLength(count);
  });

  it.each(['result', 'lines'] as const)('retries a terminal record missing its %s without another event', async (missing) => {
    const final: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo final result.', lines: [] };
    const incomplete = { ...final } as Partial<ActionDetail>;
    delete incomplete[missing];
    fetch.mockResolvedValueOnce(json(incomplete));
    await event(final);
    records.set(first.id, final);
    await renderAct(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(reads(first.id)).toHaveLength(2);
    expect(current.completed).toEqual([final]);
  });

  it('retries a failed correction fetch even when the previous record was complete', async () => {
    const done: ActionDetail = { ...first, state: 'done', endedAt: 2, result: 'Demo completed.', lines: [] };
    records.set(first.id, done);
    await event(done);
    records.set(first.id, { ...done, state: 'failed', result: 'Demo audit failure.' });
    fetch.mockResolvedValueOnce(json({}, 503));
    await event(done);
    await renderAct(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(current.action?.state).toBe('failed');
    expect(current.result).toBe('Demo audit failure.');
  });

  it('retries action details during a status outage', async () => {
    await event(first);
    const final: ActionDetail = { ...first, state: 'done', endedAt: 2, result: 'Demo completed offline.', lines: [] };
    fetch.mockImplementation(async (path: string) => path.startsWith('/api/power/actions/') ? json(final) : json({}, 503));
    await renderAct(async () => vi.advanceTimersByTimeAsync(1_200));
    expect(current.unavailable).toBe(true);
    expect(current.result).toBe(final.result);
  });

  it('ignores action IDs from a superseded HTTP snapshot while retaining the newest HTTP outage', async () => {
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.load();
    status = { running: false, sentence: 'Demo offline.', presence: [] };
    await renderAct(async () => current.refresh());
    const final: ActionDetail = { ...first, state: 'failed', endedAt: 3, result: 'Demo missed outcome.', lines: [] };
    records.set(first.id, final);
    await renderAct(async () => { pending.resolve(json({ ...healthy, status: { ...healthy.status!, running: first } })); await read; });
    expect(current.status).toBeNull();
    expect(current.sentence).toBe('Demo offline.');
    expect(current.completed).toEqual([]);
    expect(reads(first.id)).toHaveLength(0);
  });

  it('refetches a completed record after a hidden event on visibility return', async () => {
    const done: ActionDetail = { ...first, state: 'done', endedAt: 2, result: 'Demo completed.', lines: [] };
    records.set(first.id, done);
    await event(done);
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => document.dispatchEvent(new Event('visibilitychange')));
    records.set(first.id, { ...done, state: 'failed', result: 'Demo audit failure.' });
    await event(done);
    expect(reads(first.id)).toHaveLength(1);
    await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(current.action?.state).toBe('failed');
    expect(current.result).toBe('Demo audit failure.');
  });

  it.each(['reconnect', 'visibility', 'refresh', 'status'] as const)('recovers a missed terminal correction after %s with a successor running', async (recovery) => {
    const store = await import('./store');
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo apparent success.', lines: ['Demo command finished.'] };
    records.set(first.id, done);
    await event(done);
    await event(second);
    expect(current.completed).toEqual([done]);
    expect(reads(first.id)).toHaveLength(1);
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo final audit error.'] };
    records.set(first.id, failed);
    // The supervisor's correction event was missed; only its stored record changed.
    if (recovery === 'reconnect') {
      await renderAct(async () => store.setState((s) => ({ ...s, socket: 'closed' })));
      await renderAct(async () => {
        store.setState((s) => ({ ...s, socket: 'open' }));
        power.applyPowerEvent({ type: 'power_status', power: { ...healthy, status: { ...healthy.status!, running: second } } });
      });
    } else if (recovery === 'visibility') {
      let hidden = true;
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
      await renderAct(async () => document.dispatchEvent(new Event('visibilitychange')));
      await renderAct(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(reads(first.id)).toHaveLength(1);
      await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    } else if (recovery === 'refresh') await renderAct(async () => current.refresh());
    else {
      status = { running: false, sentence: 'Demo supervisor offline.', presence: [] };
      await renderAct(async () => power.load());
      status = { ...healthy, status: { ...healthy.status!, running: second } };
      await renderAct(async () => power.load());
    }
    expect(reads(first.id)).toHaveLength(2);
    expect(current.action?.id).toBe(second.id);
    expect(current.completed).toEqual([failed]);
    expect(container.querySelector('.power-completed')?.textContent).toContain(failed.result);
    expect(container.textContent).not.toContain(done.result);
    await renderAct(async () => container.querySelector<HTMLElement>('.power-completed summary')!.click());
    expect(container.querySelector('.power-completed pre')?.textContent).toBe(failed.lines.join('\n'));
    await renderAct(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(reads(first.id)).toHaveLength(2);
  });

  it('revalidates the selected completed banner after reconnect and retries a failed record read', async () => {
    const store = await import('./store');
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo apparent success.', lines: [] };
    records.set(first.id, done);
    await event(done);
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo audit error.'] };
    records.set(first.id, failed);
    fetch.mockResolvedValueOnce(json({}, 503));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'closed' })));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    expect(reads(first.id)).toHaveLength(2);
    await renderAct(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(reads(first.id)).toHaveLength(3);
    expect(current.action?.state).toBe('failed');
    expect(current.result).toBe(failed.result);
    expect(current.lines).toEqual(failed.lines);
    expect(container.querySelector('.power-banner')?.textContent).toContain(failed.result);
    expect(container.textContent).not.toContain(done.result);
  });

  it('skips dismissed completed records during recovery', async () => {
    const store = await import('./store');
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo dismissed result.', lines: [] };
    records.set(first.id, done);
    await event(done);
    await renderAct(async () => current.dismiss(first.id));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    await renderAct(async () => current.refresh());
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => document.dispatchEvent(new Event('visibilitychange')));
    await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads(first.id)).toHaveLength(1);
    expect(current.completed).toEqual([]);
    expect(current.action).toBeNull();
  });

  it('defers completed-record revalidation on a hidden reconnect until visibility returns', async () => {
    const store = await import('./store');
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo apparent success.', lines: [] };
    records.set(first.id, done);
    await event(done);
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => document.dispatchEvent(new Event('visibilitychange')));
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo audit error.'] };
    records.set(first.id, failed);
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'closed' })));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    expect(reads(first.id)).toHaveLength(1);
    await renderAct(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads(first.id)).toHaveLength(2);
    expect(current.completed).toEqual([failed]);
  });

  it('invalidates a pending completed read on refresh and coalesces one recovery read', async () => {
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo apparent success.', lines: [] };
    records.set(first.id, done);
    await event(done);
    const old = deferred();
    fetch.mockImplementationOnce(() => old.promise);
    const read = power.actionLines(first.id);
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo audit error.'] };
    records.set(first.id, failed);
    await renderAct(async () => current.refresh());
    expect(reads(first.id)).toHaveLength(3);
    await renderAct(async () => { old.resolve(json(done)); await read; });
    expect(reads(first.id)).toHaveLength(3);
    expect(current.completed).toEqual([failed]);
    expect(container.textContent).not.toContain(done.result);
  });

  it('keeps a newer terminal correction over a delayed reconnect read', async () => {
    const store = await import('./store');
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo apparent success.', lines: [] };
    records.set(first.id, done);
    await event(done);
    const old = deferred();
    fetch.mockImplementationOnce(() => old.promise);
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'closed' })));
    await renderAct(async () => store.setState((s) => ({ ...s, socket: 'open' })));
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit failed.', lines: ['Demo audit error.'] };
    records.set(first.id, failed);
    await event(failed);
    expect(current.completed).toEqual([failed]);
    await renderAct(async () => old.resolve(json(done)));
    expect(current.completed).toEqual([failed]);
    expect(container.textContent).not.toContain(done.result);
  });

  it.each(['markUnpaired', 'markSignedOut'] as const)('clears recovery reads and cached completed records on %s', async (loss) => {
    const store = await import('./store');
    const done: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo completed.', lines: [] };
    records.set(first.id, done);
    await event(done);
    const pending = deferred();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => current.refresh());
    expect(reads(first.id)).toHaveLength(2);
    await renderAct(async () => store[loss]());
    await renderAct(async () => pending.resolve(json(done)));
    await renderAct(async () => {
      store.setState((s) => ({ ...s, socket: 'open' }));
      current.refresh();
    });
    expect(reads(first.id)).toHaveLength(2);
    expect(current.completed).toEqual([]);
    expect(current.action).toBeNull();
    expect(current.status).toBeNull();
    expect(current.result).toBeNull();
    expect(current.lines).toEqual([]);
    expect(container.textContent).not.toContain(done.result);
  });

  it('selects the newest running record, then the most recent undismissed terminal record', async () => {
    await event(second);
    await event(first);
    expect(current.action?.id).toBe(second.id);
    const secondDone: ActionDetail = { ...second, state: 'done', endedAt: 6, result: 'Demo second completed.' };
    records.set(second.id, secondDone);
    await event(secondDone);
    expect(current.action?.id).toBe(first.id);
    const firstDone: ActionDetail = { ...first, state: 'done', endedAt: 3, result: 'Demo first completed.' };
    records.set(first.id, firstDone);
    await event(firstDone);
    expect(current.action?.id).toBe(second.id);
    await renderAct(async () => container.querySelector<HTMLButtonElement>('.power-banner .btn-text')!.click());
    expect(current.action?.id).toBe(first.id);
    await renderAct(async () => current.dismiss(first.id));
    expect(current.action).toBeNull();
    await event(secondDone);
    expect(current.action).toBeNull();
    expect(reads(second.id).length).toBeGreaterThan(1);
  });

  it('keeps all learned IDs tracked for the page instead of evicting unresolved actions', async () => {
    fetch.mockImplementation(async (path: string) => path.startsWith('/api/power/actions/') ? json({}, 503) : json(healthy));
    for (let i = 0; i < 105; i += 1) await event({ ...first, id: `demo-tracked-${i}` });
    records.set('demo-tracked-0', { ...first, id: 'demo-tracked-0', state: 'done', endedAt: 3, result: 'Demo recovered first action.' });
    fetch.mockImplementation(async (path: string) => path === '/api/power/actions/demo-tracked-0' ? json(records.get('demo-tracked-0'))
      : path.startsWith('/api/power/actions/') ? json({}, 503) : json(healthy));
    await renderAct(async () => power.load());
    expect(current.completed[0]?.result).toBe('Demo recovered first action.');
  });

  it('drops every older response for an ID even when it finishes after the newest request fails', async () => {
    await event(first);
    const old = deferred();
    fetch.mockImplementationOnce(() => old.promise);
    const read = power.actionLines(first.id);
    fetch.mockResolvedValueOnce(json({}, 503));
    await event(first);
    await renderAct(async () => { old.resolve(json({ ...first, state: 'done', result: 'Demo stale success.' })); await read; });
    expect(current.action?.state).toBe('running');
    expect(current.result).toBeNull();
    records.set(first.id, { ...first, state: 'failed', result: 'Demo newest failure.' });
    await renderAct(async () => power.load());
    expect(current.result).toBe('Demo newest failure.');
  });

  it('corrects done to failed after an audit correction and drops an older detail response', async () => {
    const done: ActionDetail = { ...first, state: 'done', endedAt: 2, result: 'Demo restart completed.', lines: ['Demo command finished.'] };
    records.set(first.id, done);
    await event(done);
    await renderAct(async () => power.actionLines(first.id));
    expect(current.action?.state).toBe('done');
    const old = deferred();
    fetch.mockImplementationOnce(() => old.promise);
    const pending = power.actionLines(first.id);
    const failed: ActionDetail = { ...done, state: 'failed', result: 'Demo audit could not be saved.', lines: ['Demo final audit error.'] };
    records.set(first.id, failed);
    await event(failed);
    await renderAct(async () => { old.resolve(json(done)); await pending; });
    await renderAct(async () => power.load());
    expect(current.action?.state).toBe('failed');
    expect(current.result).toBe(failed.result);
    expect(current.lines).toEqual(failed.lines);
    expect(container.textContent).not.toContain(done.result);
  });

  it('remembers a delayed accepted ID after its successor arrived, even when its events were missed', async () => {
    const accepted = deferred();
    fetch.mockImplementationOnce(() => accepted.promise);
    const post = power.act({ verb: 'restart', target: 'coder' });
    await event(second);
    records.set(first.id, { ...first, state: 'failed', endedAt: 3, result: 'Demo first action failed.', lines: ['Demo first final output.'] });
    await renderAct(async () => { accepted.resolve(json({ action: { ...first, state: 'queued' } }, 202)); await post; });
    await renderAct(async () => { await power.load(); await power.load(); });
    expect(reads(first.id).length).toBeGreaterThan(0);
    expect(current.action?.id).toBe(second.id);
    expect(current.completed).toContainEqual(records.get(first.id));
    expect(container.querySelector('.power-completed')?.textContent).toContain('Demo first action failed.');
  });

  it('fetches final details after caching a running provisional result', async () => {
    const provisional: ActionDetail = { ...first, result: 'Demo provisional error.', lines: ['Demo provisional output.'] };
    records.set(first.id, provisional);
    await event(first);
    await renderAct(async () => power.actionLines(first.id));
    const final: ActionDetail = { ...first, state: 'failed', endedAt: 3, result: 'Demo final error.', lines: ['Demo final output.'] };
    records.set(first.id, final);
    await event(final);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: healthy }));
    await renderAct(async () => power.load());
    expect(current.action?.state).toBe('failed');
    expect(current.result).toBe(final.result);
    expect(current.lines).toEqual(final.lines);
    expect(container.textContent).not.toContain(provisional.result);
  });
});
