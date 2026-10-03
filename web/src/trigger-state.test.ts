// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleJob, ScheduleList } from '../../shared/protocol';
import { api } from './api';
import { ConnectorsSheet } from './components/ConnectorsSheet';
import { SchedulesSheet } from './components/SchedulesSheet';

vi.mock('./api', () => ({ api: {
  connectors: vi.fn(), triggers: vi.fn(), pauseTrigger: vi.fn(),
  schedules: vi.fn(), pauseSchedule: vi.fn(), scheduleRuns: vi.fn(async () => []),
} }));
vi.mock('./store', () => ({ toast: vi.fn(), useStore: () => 0 }));
vi.mock('./router', () => ({ navigate: vi.fn(), conversationPath: () => '/' }));
vi.mock('./components/common', () => ({
  Sheet: ({ children }: { children: ReactNode }) => createElement('div', {}, children),
  ConfirmDialog: () => null, useFocusTrap: () => {},
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('unsafe trigger controls', () => {
  it.each(['active', 'running', 'paused'] as const)('keeps the actual %s schedule state and allows only pausing', async (state) => {
    const job: ScheduleJob = { source: 'hermes', id: 'fake-job', name: 'Demo mail', title: 'Demo mail',
      schedule: 'every 15m', scheduleInput: '*/15 * * * *', state, skills: [], deliver: 'local',
      deliverLabel: 'Local', failureStreak: 0, runs: 0, trigger: true, script: true, plumbing: true,
      inactiveReason: 'Created in shadow. Pause this trigger and recreate it from primary.' };
    const list: ScheduleList = { jobs: [job], targets: [] };
    vi.mocked(api.schedules).mockResolvedValue(list);
    vi.mocked(api.pauseSchedule).mockResolvedValue({ ...list, jobs: [{ ...job, state: 'paused' }] });
    await act(async () => root.render(createElement(SchedulesSheet, { onClose() {} })));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe(String(state !== 'paused'));
    expect(toggle.disabled).toBe(state === 'paused');
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-head')!.click());
    expect(container.querySelector('.schedule-facts dd')?.textContent).toBe(
      state === 'running' ? 'Running now' : state === 'paused' ? 'Paused' : 'Active');
    const run = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Run now'))!;
    expect(run.disabled).toBe(true);
    if (state !== 'paused') {
      await act(async () => toggle.click());
      expect(api.pauseSchedule).toHaveBeenCalledWith('hermes', 'fake-job', true);
      expect(toggle.disabled).toBe(true);
    }
  });

  it.each([false, true])('shows backend paused=%s in Connectors and allows only pausing', async (paused) => {
    vi.mocked(api.connectors).mockResolvedValue({ connectors: [], hermes: true, helper: true });
    vi.mocked(api.triggers).mockResolvedValue({ triggers: [{ id: 'fake-job', name: 'Demo mail', query: 'label:fake-demo',
      action: 'Summarize it.', every: 15, deliver: 'local', paused, role: 'shadow',
      inactiveReason: paused ? 'Created in shadow, inactive' : 'Created in shadow. Pause this trigger and recreate it from primary.' }],
      targets: [], ready: false });
    vi.mocked(api.pauseTrigger).mockResolvedValue({ ok: true });
    await act(async () => root.render(createElement(ConnectorsSheet, { onClose() {} })));
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe(String(!paused));
    expect(toggle.disabled).toBe(paused);
    if (!paused) {
      expect(container.textContent).toContain('Pause this trigger');
      expect(container.textContent).not.toContain('Created in shadow, inactive');
      await act(async () => toggle.click());
      expect(api.pauseTrigger).toHaveBeenCalledWith('fake-job', true);
    }
  });
});
