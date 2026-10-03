// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, PowerStatus } from '../../shared/protocol';

vi.mock('./events', () => ({ startEvents: vi.fn(), onVoiceEvent: vi.fn() }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), refreshList: async () => {} }));

const device: DeviceInfo = { id: 'demo-phone', name: 'Demo phone', kind: 'phone', scopes: [], created: 1, lastSeen: 1 };
const healthy: PowerStatus = {
  running: true, sentence: 'Demo services are running.', presence: [],
  status: { overall: 'ok', sentence: 'Demo services are running.', at: 1, components: [
    { id: 'coder', name: 'Second model', state: 'up', sentence: 'Ready.', actions: ['restart'] },
  ] },
};
const unavailable: PowerStatus = { running: false, sentence: 'Demo supervisor is offline.', presence: [] };
const confirmation = { confirm: 'demo-confirm-token', summary: 'Restart Second model.' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let root: Root;
let container: HTMLDivElement;
let power: typeof import('./power');
let store: typeof import('./store');
let fetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetModules();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  store = await import('./store');
  store.setState((s) => ({ ...s, device, listLoaded: true }));
  fetch = vi.fn(async (path: string) => path === '/api/power/actions' ? json(confirmation, 202)
    : path === '/api/me' ? json({ statuses: [] }) : json(healthy));
  vi.stubGlobal('fetch', fetch);
  power = await import('./power');
  history.replaceState(null, '', '/settings/status');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const { App } = await import('./App');
  // Module imports must settle before fake timers take over the app's polling.
  vi.useFakeTimers();
  await act(async () => root.render(h(App)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const click = async (selector: string) => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
const ask = async () => { await click('.power-actions button'); await click('[role="menuitem"]'); };
const posts = () => fetch.mock.calls.filter(([path]) => path === '/api/power/actions');
const change = async (loss: string) => {
  if (loss === 'identity removed') store.setState((s) => ({ ...s, device: undefined }));
  else if (loss === 'identity replaced') store.setState((s) => ({ ...s, device: { ...device, id: 'demo-other-phone' } }));
  else if (loss === 'kind changed') store.setState((s) => ({ ...s, device: { ...device, kind: 'desktop' } }));
  else if (loss === 'revoked') store.markUnpaired();
  else if (loss === 'expired') store.markSignedOut();
  else {
    fetch.mockResolvedValueOnce(json(unavailable));
    await power.load();
    if (loss === 'outage then recovery') await power.load();
  }
};
const losses = ['identity removed', 'identity replaced', 'kind changed', 'revoked', 'expired', 'outage', 'outage then recovery'];

describe('phone confirmation belongs to its identity and availability', () => {
  it.each(['identity removed', 'identity replaced'])('dismisses an open confirmation when %s without another tap', async (loss) => {
    await ask();
    expect(container.querySelector('.confirm-card')).not.toBeNull();
    await act(async () => change(loss));
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it.each(losses)('dismisses an open confirmation on %s and rejects a click before rendering', async (loss) => {
    await ask();
    const run = container.querySelector<HTMLButtonElement>('.confirm-card .btn-primary')!;
    expect(run).not.toBeNull();
    await act(async () => { await change(loss); run.click(); });
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(posts()).toHaveLength(1);
    await act(async () => power.applyPowerEvent({ type: 'power_status', power: healthy }));
    expect(container.querySelector('.confirm-card')).toBeNull();
  });

  it.each(losses)('discards a confirmation response that arrives after %s', async (loss) => {
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    await ask();
    await act(async () => change(loss));
    await act(async () => resolve(json(confirmation, 202)));
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it('refuses to post a confirmation while the supervisor is unavailable', async () => {
    fetch.mockResolvedValueOnce(json(unavailable));
    await act(async () => power.load());
    await expect(power.act({ verb: 'restart', target: 'coder', confirm: 'demo-confirm-token' })).resolves.toMatchObject({ kind: 'error' });
    expect(posts()).toHaveLength(0);
  });

  it.each(['http-error', 'network-error'])('dismisses the confirmation after a failed status refresh: %s', async (failure) => {
    await ask();
    if (failure === 'http-error') fetch.mockResolvedValueOnce(json({}, 503));
    else fetch.mockRejectedValueOnce(new Error('Demo connection lost'));
    await act(async () => power.load());
    expect(container.querySelector('.confirm-card')).toBeNull();
    expect(posts()).toHaveLength(1);
  });
});
