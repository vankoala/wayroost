// @vitest-environment jsdom
import { act as renderAct, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE_DEVICE_REVOKED, WS_CLOSE_SESSION_EXPIRED, type DeviceInfo, type PowerStatus } from '../../shared/protocol';
import type { ActionDetail, ActionSummary } from '../../shared/supervisor';

const device: DeviceInfo = { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 };
const action: ActionSummary = { id: 'demo-action', verb: 'restart', target: 'coder', state: 'queued', caller: 'demo', startedAt: 1 };
const successor: ActionSummary = { ...action, id: 'demo-successor', verb: 'hold', state: 'running', startedAt: 4 };
const healthy: PowerStatus = {
  running: true, sentence: 'Demo services are running.',
  status: { overall: 'ok', sentence: 'Demo services are running.', at: 2, components: [
    { id: 'coder', name: 'Second model', state: 'up', sentence: 'Demo model is answering.', actions: ['restart', 'stop', 'hold', 'diagnostics'] },
  ] },
  presence: [{ device: 'demo-phone', kind: 'phone', state: 'active', at: 1 }],
};
const unavailable: PowerStatus = { running: false, sentence: 'Demo supervisor is offline.', presence: [] };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

let root: Root;
let container: HTMLDivElement;
let power: typeof import('./power');
let current: import('./power').Power;
let store: typeof import('./store');
let fetch: ReturnType<typeof vi.fn>;
let detail: ActionDetail;
let successorDetail: ActionDetail;
let powerStatus: PowerStatus;
const detailResponse = (path: string) => {
  if (path === '/api/power/actions/demo-action') return json(detail);
  if (path === '/api/power/actions/demo-successor') return json(successorDetail);
  if (path === '/api/power/actions/demo-middle') return json({ ...action, id: 'demo-middle', state: 'running', startedAt: 2, lines: [] });
  if (path === '/api/power/actions/demo-new-action') return json({ ...action, id: 'demo-new-action', verb: 'hold', state: 'running', lines: [] });
  return json({}, 404);
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  vi.useFakeTimers();
  store = await import('./store');
  store.setState((s) => ({ ...s, device }));
  detail = { ...action, state: 'failed', endedAt: 3, result: 'Demo restart failed to answer.', lines: ['Demo final diagnostic.'] };
  successorDetail = { ...successor, lines: [] };
  powerStatus = healthy;
  fetch = vi.fn(async (path: string) => {
    if (path === '/api/me') return json({ device, statuses: [] });
    if (path === '/api/power/actions') return json({ action }, 202);
    if (path.startsWith('/api/power/actions/')) return detailResponse(path);
    return json(powerStatus);
  });
  vi.stubGlobal('fetch', fetch);
  power = await import('./power');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await renderAct(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const { StatusPage } = await import('./pages/StatusPage');
  const { StatusBlock } = await import('./components/StatusBlock');
  function Watcher() { current = power.usePower(); return null; }
  await renderAct(async () => root.render(h('div', null, h(Watcher), h(StatusBlock), h(StatusPage, { onConfirm: vi.fn() }))));
};
const click = async (text: string) => renderAct(async () => {
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!.click();
});
const assertCleared = () => {
  expect(power.powerSnapshot()).toBeNull();
  expect(container.querySelector('.power-actions')).toBeNull();
  expect(container.querySelector('.power-presence')).toBeNull();
  expect(container.querySelector('.power-banner')).toBeNull();
  expect(container.querySelector('.power-lines')).toBeNull();
  expect(container.textContent).not.toContain('Demo model is answering.');
};

describe('power waits for a paired device identity', () => {
  it('uses HTTP identity when hello is delayed and exposes only the phone subset', async () => {
    const me = deferred<Response>();
    store.setState((s) => ({ ...s, device: undefined }));
    fetch.mockImplementationOnce(() => me.promise);
    await mount();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/me']);
    assertCleared();
    await expect(power.act({ verb: 'stop', target: 'coder' })).resolves.toMatchObject({ kind: 'error' });
    await renderAct(async () => me.resolve(json({ device: { ...device, id: 'demo-phone', kind: 'phone' }, statuses: [] })));
    expect(store.getState().device?.kind).toBe('phone');
    expect(container.querySelector('.power-actions')?.textContent).toBe('Restart');
    expect(container.textContent).not.toContain('Run diagnostics');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/me', '/api/power']);
  });

  it.each([undefined, { ...device, kind: 'unknown' }, { ...device, id: '' }])('fails closed for an unusable identity: %j', async (unknown) => {
    store.setState((s) => ({ ...s, device: undefined }));
    fetch.mockResolvedValue(json({ device: unknown, statuses: [] }));
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: healthy }));
    assertCleared();
    expect(fetch.mock.calls.every(([path]) => path === '/api/me')).toBe(true);
  });

  it('keeps a newer hello identity over a delayed HTTP identity', async () => {
    const me = deferred<Response>();
    store.setState((s) => ({ ...s, device: undefined }));
    fetch.mockImplementationOnce(() => me.promise);
    await mount();
    await renderAct(async () => {
      store.applyEvent({ type: 'hello', device: { ...device, id: 'demo-phone', kind: 'phone' }, statuses: [] });
      me.resolve(json({ device, statuses: [] }));
    });
    expect(store.getState().device?.kind).toBe('phone');
    expect(container.querySelector('.power-actions')?.textContent).toBe('Restart');
  });
});

describe('authentication loss clears and invalidates power state', () => {
  it.each(['markUnpaired', 'markSignedOut'] as const)('clears status, presence, action and lines on %s and rejects delayed reads', async (loss) => {
    await mount();
    await renderAct(async () => { await power.act({ verb: 'restart', target: 'coder' }); });
    await click('Show progress');
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    let read!: Promise<void>;
    await renderAct(async () => { read = power.load(); });
    await renderAct(async () => store[loss]());
    assertCleared();
    await renderAct(async () => { pending.resolve(json(healthy)); await read; });
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: healthy }));
    assertCleared();
    fetch.mockClear();
    await renderAct(async () => { await power.load(); await power.actionLines(action.id); await vi.advanceTimersByTimeAsync(15_000); });
    await expect(power.act({ verb: 'restart', target: 'coder' })).resolves.toMatchObject({ kind: 'error' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['unpaired', 'expired'])('clears power when a common API request reports %s', async (error) => {
    await mount();
    const { request } = await import('./api');
    fetch.mockResolvedValueOnce(json({ error }, 401));
    await renderAct(async () => { await request('GET', '/api/me').catch(() => {}); });
    assertCleared();
  });

  it.each([WS_CLOSE_SESSION_EXPIRED, WS_CLOSE_DEVICE_REVOKED])('clears power on authentication socket close %s', async (code) => {
    await mount();
    const sockets: Array<{ onclose?: (event: { code: number }) => void }> = [];
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      onclose?: (event: { code: number }) => void;
      constructor() { sockets.push(this); }
    });
    const events = await import('./events');
    await renderAct(async () => { events.connect(); sockets[0]!.onclose!({ code }); });
    assertCleared();
  });

  it('does not let an old read block or overwrite the next paired session', async () => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const old = power.load();
    await renderAct(async () => {
      store.markUnpaired();
      store.setState((s) => ({ ...s, unpaired: false, device: { ...device, id: 'demo-new-device' } }));
    });
    expect(power.powerSnapshot()).toEqual(healthy.status);
    await renderAct(async () => { pending.resolve(json({ error: 'unpaired' }, 401)); await old; });
    expect(store.getState().unpaired).toBe(false);
    expect(power.powerSnapshot()).toEqual(healthy.status);
  });

  it('invalidates a pending identity read on revocation', async () => {
    const pending = deferred<Response>();
    store.setState((s) => ({ ...s, device: undefined }));
    fetch.mockImplementationOnce(() => pending.promise);
    await mount();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/me');
    await renderAct(async () => store.markUnpaired());
    await renderAct(async () => pending.resolve(json({ device, statuses: [] })));
    expect(store.getState().device).toBeUndefined();
    assertCleared();
  });

  it.each([{ action }, { confirm: 'demo-confirm', summary: 'Demo restart?' }])('invalidates an action response after session expiry: %j', async (response) => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const post = power.act({ verb: 'restart', target: 'coder' });
    await renderAct(async () => store.markSignedOut());
    await renderAct(async () => pending.resolve(json(response, 202)));
    await expect(post).resolves.toMatchObject({ kind: 'error' });
    assertCleared();
  });

  it('invalidates pending progress and terminal result reads on session expiry', async () => {
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: { ...action, state: 'running' } }));
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await click('Show progress');
    await renderAct(async () => store.markSignedOut());
    await renderAct(async () => pending.resolve(json(detail)));
    assertCleared();
  });

  it.each(['unpaired', 'expired', 'redirect'] as const)('handles %s from a superseded detail read', async (loss) => {
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.actionLines(action.id);
    fetch.mockResolvedValueOnce(json({}, 503));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action')).toHaveLength(3);
    expect(container.querySelector('.power-actions')).not.toBeNull();
    await renderAct(async () => {
      const response = loss === 'redirect'
        ? { type: 'opaqueredirect', status: 0, ok: false, json: async () => ({}) } as Response
        : json({ error: loss }, 401);
      pending.resolve(response);
      await read;
    });
    expect(store.getState().unpaired).toBe(loss === 'unpaired');
    expect(store.getState().sessionExpired).toBe(loss !== 'unpaired');
    assertCleared();
    expect(container.querySelector('.power-completed')).toBeNull();
    fetch.mockClear();
    await renderAct(async () => { await power.load(); await power.actionLines(action.id); await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['unpaired', 'expired', 'redirect'] as const)('ignores %s from a detail read belonging to the previous identity', async (loss) => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.actionLines(action.id);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_line', actionId: action.id, line: 'Demo newer hint.' }));
    await renderAct(async () => store.setState((s) => ({ ...s, device: { ...device, id: 'demo-next-desktop' } })));
    const count = fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action').length;
    await renderAct(async () => {
      pending.resolve(loss === 'redirect'
        ? { type: 'opaqueredirect', status: 0, ok: false, json: async () => ({}) } as Response
        : json({ error: loss }, 401));
      await read;
    });
    expect(store.getState().unpaired).toBe(false);
    expect(store.getState().sessionExpired).toBe(false);
    expect(power.powerSnapshot()).toEqual(healthy.status);
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action')).toHaveLength(count);
  });
});

describe('HTTP status reads remain independent of socket hints', () => {
  it.each(['line', 'running', 'terminal'].flatMap((hint) => ['http', 'network', 'malformed'].map((failure) => [hint, failure])))('fails closed after a %s hint during a %s status failure', async (hint, failure) => {
    await mount();
    const guard = current.actionGuard();
    expect(guard()).toBe(true);
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.load();
    await renderAct(async () => power.applyPowerEvent(hint === 'line'
      ? { type: 'power_line', actionId: action.id, line: 'Demo progress hint.' }
      : { type: 'power_action', action: hint === 'terminal' ? detail : { ...action, state: 'running' } }));
    await renderAct(async () => {
      if (failure === 'network') pending.reject(new Error('Demo connection lost.'));
      else pending.resolve(failure === 'http' ? json({}, 503) : json({ error: 'Demo malformed response.' }));
      await read;
    });
    expect(current.status).toBeNull();
    expect(current.unavailable).toBe(true);
    expect(current.presence).toEqual([]);
    expect(container.querySelector('.power-actions')).toBeNull();
    expect(guard()).toBe(false);
    await expect(power.act({ verb: 'stop', target: 'coder' })).resolves.toMatchObject({ kind: 'error' });
    expect(fetch.mock.calls.some(([path]) => path === '/api/power/actions')).toBe(false);
    await renderAct(async () => power.load());
    expect(current.actionGuard()()).toBe(true);
    expect(guard()).toBe(false);
  });

  it.each(['http', 'network'] as const)('fetches newer HTTP status after an older %s failure and socket hints', async (failure) => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.load();
    const newer = { ...healthy, status: { ...healthy.status!, at: 4, sentence: 'Demo newer status.' } };
    powerStatus = newer;
    await renderAct(async () => {
      power.applyPowerEvent({ type: 'power_status', power: newer });
      power.applyPowerEvent({ type: 'power_line', actionId: action.id, line: 'Demo progress hint.' });
    });
    await renderAct(async () => {
      if (failure === 'network') pending.reject(new Error('Demo connection lost.'));
      else pending.resolve(json({}, 503));
      await read;
    });
    expect(current.status).toEqual(newer.status);
    expect(current.unavailable).toBe(false);
    expect(current.actionGuard()()).toBe(true);
    expect(container.querySelector('.power-actions')).not.toBeNull();
  });

  it.each(['healthy', 'http-error', 'network-error'])('fetches an outage after a socket hint during a delayed %s response', async (response) => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const read = power.load();
    powerStatus = unavailable;
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: unavailable }));
    await renderAct(async () => {
      if (response === 'network-error') pending.reject(new Error('Demo disconnection'));
      else pending.resolve(json(response === 'healthy' ? healthy : {}, response === 'healthy' ? 200 : 503));
      await read;
    });
    assertCleared();
    expect(container.querySelector('.status-block')?.textContent).toContain(unavailable.sentence);
    powerStatus = healthy;
    await renderAct(async () => { await power.load(); });
    expect(container.querySelector('.power-actions')).not.toBeNull();
  });
});

describe('terminal power action results survive the running snapshot', () => {
  const showCompletedProgress = async () => {
    const progress = container.querySelector<HTMLDetailsElement>('.power-completed details')!;
    await renderAct(async () => progress.querySelector<HTMLElement>('summary')!.click());
    expect(progress.open).toBe(true);
    return progress.textContent;
  };

  it.each(['done', 'failed', 'cancelled'] as const)('retains a delayed %s result while a successor is running', async (state) => {
    detail = { ...detail, state };
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    await renderAct(async () => pending.resolve(json(detail)));
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
    expect(container.textContent).toContain(detail.result);
    expect(await showCompletedProgress()).toContain('Demo final diagnostic.');
    await renderAct(async () => power.load());
    expect(container.textContent).toContain(detail.result);
  });

  it('retains a completed result and its output after a successor starts', async () => {
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    expect(container.textContent).toContain(detail.result);
    expect(await showCompletedProgress()).toContain('Demo final diagnostic.');
  });

  it('keeps a successor selected when an older detail response has the same start time', async () => {
    successorDetail = { ...successorDetail, startedAt: action.startedAt };
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: { ...successor, startedAt: action.startedAt } }));
    await renderAct(async () => pending.resolve(json(detail)));
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
    expect(container.querySelector('.power-completed')?.textContent).toContain(detail.result);
  });

  it('does not invalidate a terminal read when a successor prints output', async () => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    successorDetail = { ...successorDetail, lines: ['Demo successor progress.'] };
    await renderAct(async () => {
      power.applyPowerEvent({ type: 'power_action', action: successor });
      power.applyPowerEvent({ type: 'power_line', actionId: successor.id, line: 'Demo successor progress.' });
    });
    await renderAct(async () => pending.resolve(json(detail)));
    expect(container.querySelector('.power-completed')?.textContent).toContain(detail.result);
    await click('Show progress');
    expect(container.querySelector('.power-lines pre')?.textContent).toBe('Demo successor progress.');
  });

  it('fetches a hidden terminal result on return even when a successor is running', async () => {
    await mount();
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      power.applyPowerEvent({ type: 'power_action', action: detail });
      power.applyPowerEvent({ type: 'power_action', action: successor });
    });
    expect(fetch.mock.calls.some(([path]) => path === '/api/power/actions/demo-action')).toBe(false);
    await renderAct(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(container.querySelector('.power-completed')?.textContent).toContain(detail.result);
  });

  it('retries a failed terminal detail read independently of its successor', async () => {
    await mount();
    fetch.mockResolvedValueOnce(json({}, 503));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    await renderAct(async () => power.load());
    expect(container.textContent).toContain(detail.result);
  });

  it('shows an older terminal event that arrives after its successor started', async () => {
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
    expect(container.textContent).toContain(detail.result);
  });

  it('keeps newer output for a completed action over its delayed detail read', async () => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    detail = { ...detail, lines: ['Demo newer final output.'] };
    await renderAct(async () => power.applyPowerEvent({ type: 'power_line', actionId: action.id, line: 'Demo newer final output.' }));
    await renderAct(async () => pending.resolve(json({ ...detail, result: 'Demo stale result.', lines: ['Demo stale output.'] })));
    expect(container.textContent).toContain(detail.result);
    expect(await showCompletedProgress()).toContain('Demo newer final output.');
    expect(container.textContent).not.toContain('Demo stale output.');
    expect(container.textContent).not.toContain('Demo stale result.');
  });

  it.each(['markUnpaired', 'markSignedOut'] as const)('clears completed results and invalidates their pending reads on %s', async (loss) => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: successor }));
    await renderAct(async () => store[loss]());
    await renderAct(async () => pending.resolve(json(detail)));
    expect(container.textContent).not.toContain(detail.result);
    assertCleared();
  });

  it.each(['done', 'failed', 'cancelled'] as const)('retains the accepted ID and displays the %s result and bounded lines', async (state) => {
    detail = { ...detail, state, result: `Demo action ${state}.`, lines: Array.from({ length: 205 }, (_, i) => `Demo line ${i}`) };
    await mount();
    await renderAct(async () => { await power.act({ verb: 'restart', target: 'coder' }); });
    expect(container.querySelector('.power-banner')).not.toBeNull();
    // The server sends a status without running before the terminal action event.
    await renderAct(async () => {
      power.applyPowerEvent({ type: 'power_status', power: healthy });
      power.applyPowerEvent({ type: 'power_action', action: { ...action, state, endedAt: 3 } });
    });
    expect(container.querySelector('.power-banner')?.textContent).toContain(detail.result);
    await click('Show progress');
    const lines = container.querySelector('.power-lines pre')!.textContent!.split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('Demo line 5');
    expect(fetch.mock.calls.some(([path]) => path === '/api/power/actions/demo-action')).toBe(true);
    await renderAct(async () => { await power.load(); });
    expect(container.querySelector('.power-banner')?.textContent).toContain(detail.result);
  });

  it('keeps a terminal event that arrives before the accepted HTTP response', async () => {
    await mount();
    const accepted = deferred<Response>();
    fetch.mockImplementationOnce(() => accepted.promise);
    const post = power.act({ verb: 'restart', target: 'coder' });
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    await renderAct(async () => { accepted.resolve(json({ action }, 202)); await post; });
    expect(container.querySelector('.power-banner')?.textContent).toContain(detail.result);
    expect(container.querySelector('.power-banner')?.textContent).not.toContain('queued');
  });

  it('recovers the final result when a terminal event was missed during reconnect', async () => {
    await mount();
    const final = detail;
    detail = { ...action, state: 'running', lines: [] };
    powerStatus = {
      ...healthy, status: { ...healthy.status!, running: { ...action, state: 'running' } },
    };
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: powerStatus }));
    detail = final;
    powerStatus = healthy;
    await renderAct(async () => power.applyPowerEvent({ type: 'power_status', power: healthy }));
    expect(container.querySelector('.power-banner')?.textContent).toContain(detail.result);
  });

  it.each(['done', 'failed', 'cancelled'] as const)('recovers a missed %s result when reconnect finds a successor running', async (state) => {
    const final = { ...detail, state };
    detail = { ...action, state: 'running', lines: [] };
    powerStatus = { ...healthy, status: { ...healthy.status!, running: { ...action, state: 'running' } } };
    await mount();
    detail = final;
    const reconnected = { ...healthy, status: { ...healthy.status!, running: successor } };
    fetch.mockImplementation(async (path: string) => path.startsWith('/api/power/actions/') ? detailResponse(path) : json(reconnected));
    await renderAct(async () => power.load());
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
    expect(container.querySelector('.power-completed')?.textContent).toContain(detail.result);
    expect(await showCompletedProgress()).toContain('Demo final diagnostic.');
    await renderAct(async () => power.load());
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action')).toHaveLength(2);
  });

  it('reconciles every superseded action and retries failures without duplicating pending reads', async () => {
    await mount();
    const final = detail;
    detail = { ...action, state: 'running', lines: [] };
    const middle = { ...action, id: 'demo-middle', state: 'running' as const, startedAt: 2 };
    await renderAct(async () => {
      power.applyPowerEvent({ type: 'power_action', action: { ...action, state: 'running' } });
      power.applyPowerEvent({ type: 'power_action', action: middle });
    });
    const previousReads = fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action').length;
    detail = final;
    const pending = deferred<Response>();
    const middleDetail = { ...detail, id: middle.id, startedAt: middle.startedAt, result: 'Demo middle finished.' };
    let attempts = 0;
    fetch.mockImplementation(async (path: string) => {
      if (path === '/api/power/actions/demo-action') return pending.promise;
      if (path === '/api/power/actions/demo-middle') return ++attempts === 1 ? json({}, 503) : json(middleDetail);
      if (path.startsWith('/api/power/actions/')) return detailResponse(path);
      return json({ ...healthy, status: { ...healthy.status!, running: successor } });
    });
    await renderAct(async () => power.load());
    await renderAct(async () => power.load());
    expect(container.querySelector('.power-completed')?.textContent).toContain(middleDetail.result);
    expect(fetch.mock.calls.filter(([path]) => path === '/api/power/actions/demo-action')).toHaveLength(previousReads + 1);
    expect(attempts).toBe(2);
    await renderAct(async () => pending.resolve(json(detail)));
    expect(container.textContent).toContain(detail.result);
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
  });

  it('recovers a superseded action on visibility return after missing its terminal event', async () => {
    await mount();
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    await renderAct(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      power.applyPowerEvent({ type: 'power_action', action: { ...action, state: 'running' } });
      power.applyPowerEvent({ type: 'power_status', power: { ...healthy, status: { ...healthy.status!, running: successor } } });
    });
    expect(fetch.mock.calls.some(([path]) => path === '/api/power/actions/demo-action')).toBe(false);
    fetch.mockImplementation(async (path: string) => path.startsWith('/api/power/actions/') ? detailResponse(path) : json({
      ...healthy, status: { ...healthy.status!, running: successor },
    }));
    await renderAct(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(container.querySelector('.power-completed')?.textContent).toContain(detail.result);
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
  });

  it.each(['before', 'during'])('keeps a result completed %s role-tile navigation when returning to Status', async (timing) => {
    const { useUrl } = await import('./router');
    const { Link } = await import('./components/common');
    const { TeamRowBlock } = await import('./components/TeamRowBlock');
    const { StatusBlock } = await import('./components/StatusBlock');
    const { StatusPage } = await import('./pages/StatusPage');
    const { TeamPage } = await import('./pages/TeamPage');
    function Pages() {
      const url = useUrl();
      return h('div', null, h(StatusBlock), h(TeamRowBlock),
        url.startsWith('/team') ? h(TeamPage) : h(StatusPage, { onConfirm: vi.fn() }),
        h(Link, { to: '/settings/status' }, 'Back to Status'));
    }
    history.replaceState(null, '', '/settings/status');
    await renderAct(async () => root.render(h(Pages)));
    const final = detail;
    if (timing === 'during') detail = { ...action, state: 'running', lines: [] };
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: timing === 'before' ? detail : { ...action, state: 'running' } }));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await renderAct(async () => container.querySelector<HTMLAnchorElement>('.team-row .role-tile')!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(location.pathname + location.search).toBe('/team?role=manager');
    expect(container.querySelector('.page-team')).not.toBeNull();
    if (timing === 'during') {
      detail = final;
      await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    }
    await renderAct(async () => [...container.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent === 'Back to Status')!.click());
    expect(location.pathname).toBe('/settings/status');
    expect(container.querySelector('.power-result')?.textContent).toBe(detail.result);
    await click('Show progress');
    expect(container.querySelector('.power-lines pre')?.textContent).toBe('Demo final diagnostic.');
    history.replaceState(null, '', '/');
  });

  it('fetches a terminal result during outage without waiting on an older progress read', async () => {
    await mount();
    const final = detail;
    detail = { ...action, state: 'running', lines: [] };
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: { ...action, state: 'running' } }));
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await click('Show progress');
    detail = final;
    await renderAct(async () => {
      power.applyPowerEvent({ type: 'power_status', power: unavailable });
      power.applyPowerEvent({ type: 'power_action', action: detail });
    });
    expect(container.querySelector('.power-result')?.textContent).toBe(detail.result);
    await renderAct(async () => pending.resolve(json({ ...action, state: 'running', lines: ['Demo old output.'] })));
    expect(container.querySelector('.power-result')?.textContent).toBe(detail.result);
    expect(container.querySelector('.power-lines pre')?.textContent).toBe('Demo final diagnostic.');
  });

  it('refetches live lines and drops an older HTTP progress response', async () => {
    detail = { ...action, state: 'running', lines: [] };
    await mount();
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: detail }));
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    await click('Show progress');
    detail = { ...detail, lines: ['Demo newest line.'] };
    await renderAct(async () => power.applyPowerEvent({ type: 'power_line', actionId: action.id, line: 'Demo newest line.' }));
    await renderAct(async () => pending.resolve(json({ ...detail, lines: ['Demo older line.'] })));
    expect(container.querySelector('.power-lines pre')?.textContent).toBe('Demo newest line.');
  });

  it('keeps a newer action event over an older accepted response, even with equal start times', async () => {
    await mount();
    const pending = deferred<Response>();
    fetch.mockImplementationOnce(() => pending.promise);
    const post = power.act({ verb: 'restart', target: 'coder' });
    await renderAct(async () => power.applyPowerEvent({ type: 'power_action', action: { ...action, id: 'demo-new-action', verb: 'hold', state: 'running' } }));
    await renderAct(async () => { pending.resolve(json({ action }, 202)); await post; });
    expect(container.querySelector('.power-banner')?.textContent).toContain('Hold…');
  });
});
