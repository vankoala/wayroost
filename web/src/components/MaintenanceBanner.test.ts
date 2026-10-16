// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyEvent, getState, setState } from '../store.js';
import { MaintenanceBanner } from './MaintenanceBanner.js';

let container: HTMLDivElement;
let root: Root;
const initial = getState();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setState(() => ({ ...initial, maintenance: false }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setState(() => initial); });

it('shows the hold on initial connection and removes it when the owner releases it', async () => {
  await act(async () => root.render(h(MaintenanceBanner)));
  expect(container.textContent).toBe('');
  await act(async () => applyEvent({ type: 'hello', statuses: [], maintenance: true }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Maintenance: new work paused');
  await act(async () => applyEvent({ type: 'source_status', status: { source: 'hermes', state: 'connected' } }));
  expect(container.textContent).toBe('Maintenance: new work paused');
  await act(async () => applyEvent({ type: 'source_status', status: { source: 'hermes', state: 'connected' }, maintenance: false }));
  expect(container.textContent).toBe('');
});
