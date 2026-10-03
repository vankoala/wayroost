// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';

const fixture = vi.hoisted(() => ({ capabilities: vi.fn(), tasks: vi.fn() }));
vi.mock('../api', () => ({ api: fixture }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.capabilities.mockReset().mockResolvedValue({ tasks: false });
  fixture.tasks.mockReset().mockResolvedValue({ tasks: [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('shows unavailable Tasks without asking a shadow for the ledger and can recover on refresh', async () => {
  await act(async () => root.render(h(TasksPage)));
  expect(container.textContent).toContain('Tasks need the bridge, Hermes and Paseo.');
  expect(container.textContent).not.toContain('No worker tasks yet');
  expect(fixture.tasks).not.toHaveBeenCalled();
  fixture.capabilities.mockResolvedValue({ tasks: true });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh tasks"]')!.click());
  expect(fixture.tasks).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('No worker tasks yet');
  expect(container.textContent).not.toContain('Tasks need the bridge');
});

it('keeps an ordinary ledger failure on the Tasks page', async () => {
  fixture.capabilities.mockResolvedValue({ tasks: true });
  fixture.tasks.mockRejectedValue(new Error('Demo task service unavailable.'));
  await act(async () => root.render(h(TasksPage)));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Demo task service unavailable.');
});
