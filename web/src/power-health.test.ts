// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { StatusBlock } from './components/StatusBlock';
import { StatusPage } from './pages/StatusPage';
import { load } from './power';
import { setState } from './store';

it('marks a failed refresh unavailable in both the block and service controls, then recovers', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setState((s) => ({ ...s, device: { id: 'demo-desktop', name: 'Demo desktop', kind: 'desktop', scopes: [], created: 1, lastSeen: 1 } }));
  const status = { overall: 'ok', sentence: 'Everything is running.', at: 1, components: [
    { id: 'coder', name: 'Second model', state: 'up', sentence: 'It is answering.', actions: ['restart'] },
  ], running: { id: 'demo-action-1', verb: 'restart', target: 'coder', state: 'running', caller: 'demo', startedAt: 1 } };
  // GET /api/power answers with the server's envelope around the supervisor's snapshot.
  const envelope = () => new Response(JSON.stringify({ running: true, status, sentence: status.sentence, presence: [] }));
  const fetch = vi.fn().mockImplementation(envelope);
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h('div', null, h(StatusBlock), h(StatusPage, { onConfirm: vi.fn() }))));
    expect(container.querySelector('.status-block')?.textContent).toContain('Everything is running.');
    expect(container.querySelector('.power-actions button')?.textContent).toBe('Restart');
    fetch.mockResolvedValue(new Response('{}', { status: 503 }));
    await act(async () => load());
    expect(container.querySelector('.status-block')?.textContent).toContain('Status isn’t available yet');
    expect(container.querySelector('.power-actions')).toBeNull();
    expect(container.querySelector('.power-none')).not.toBeNull();
    expect(container.querySelector('.power-banner')).toBeNull();
    fetch.mockImplementation(envelope);
    await act(async () => load());
    expect(container.querySelector('.power-actions button')?.textContent).toBe('Restart');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
