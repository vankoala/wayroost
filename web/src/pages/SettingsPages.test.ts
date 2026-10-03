// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SchedulePage } from './SettingsPages';
import { SchedulesSheet } from '../components/SchedulesSheet';
import { navigate } from '../router';
import type { ScheduleJob, ScheduleRun } from '../../../shared/protocol';

const fixture = vi.hoisted(() => ({ jobs: [] as ScheduleJob[], runs: [] as ScheduleRun[] }));
vi.mock('../api', () => ({ api: {
  schedules: () => Promise.resolve({ jobs: fixture.jobs, targets: { projects: [], models: [] } }),
  scheduleRuns: () => Promise.resolve({ runs: fixture.runs }),
} }));

afterEach(() => {
  fixture.jobs = [];
  fixture.runs = [];
  vi.restoreAllMocks();
});

it('opens and closes the builder as route intent changes without leaving Schedule', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(SchedulePage, { startNew: false })));
    expect(container.querySelector('.schedule-builder')).toBeNull();
    await act(async () => root.render(h(SchedulePage, { startNew: true })));
    expect(container.querySelector('.schedule-builder')).not.toBeNull();
    await act(async () => root.render(h(SchedulePage, { startNew: false })));
    expect(container.querySelector('.schedule-builder')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  { path: '/schedule', inApp: false },
  { path: '/schedule?focus=hermes%3Ademo-job', inApp: false },
  { path: '/settings/schedule', inApp: false },
  { path: '/schedule', inApp: true },
])('returns to $path after opening a run (inApp=$inApp)', async ({ path, inApp }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  fixture.jobs = [{
    source: 'hermes', id: 'demo-job', name: 'Demo job', title: 'Demo job', plumbing: false,
    schedule: 'Every day', scheduleInput: '24h', state: 'active', skills: [], deliver: 'local',
    deliverLabel: 'Here', failureStreak: 0, runs: 1, trigger: false, script: false,
  }];
  fixture.runs = [{ id: 'demo-run', open: { source: 'hermes', id: 'demo-thread' }, title: 'Demo run', running: false }];
  history.replaceState(null, '', '/chats');
  if (inApp) navigate(path);
  else history.replaceState(null, '', path);
  const back = vi.spyOn(history, 'back');
  const replace = vi.spyOn(history, 'replaceState');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(SchedulePage, { startNew: false })));
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-head')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button.run-item')!.click());
    expect(location.pathname).toBe('/c/hermes/demo-thread');
    expect(back).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    await act(async () => { history.back(); await popped; });
    expect(location.pathname + location.search).toBe(path);
    expect(history.state).toEqual(inApp ? { signalbox: true } : null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Element.prototype.scrollIntoView = originalScroll;
  }
});

it('closes a Schedule quick-action sheet when opening a run', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.jobs = [{
    source: 'paseo', id: 'demo-job', name: 'Demo job', title: 'Demo job', plumbing: false,
    schedule: 'Every day', scheduleInput: '24h', state: 'active', skills: [], deliver: 'local',
    deliverLabel: 'Here', failureStreak: 0, runs: 1, trigger: false, script: false,
  }];
  fixture.runs = [{ id: 'demo-run', open: { source: 'paseo', id: 'demo-thread' }, title: 'Demo run', running: false }];
  history.replaceState(null, '', '/chats');
  const onClose = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(SchedulesSheet, { onClose })));
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-head')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button.run-item')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/c/paseo/demo-thread');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('updates the expanded job and scrolls again as the mounted page focus changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const scroll = vi.fn();
  const scrolled: string[] = [];
  const originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () { scroll(); scrolled.push(this.id); };
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flushFrames = () => { for (const callback of frames.values()) callback(0); frames.clear(); };
  fixture.jobs = ['demo-job-a', 'demo-job-b'].map((id): ScheduleJob => ({
    source: 'hermes', id, name: id, title: id, plumbing: false, schedule: 'Every day', scheduleInput: '24h',
    state: 'active', skills: [], deliver: 'local', deliverLabel: 'Here', failureStreak: 0, runs: 0, trigger: false, script: false,
  }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (focus?: string) => act(async () => root.render(h(SchedulePage, { startNew: false, focus })));
  try {
    await render('hermes:demo-job-a');
    flushFrames();
    expect(container.querySelector('.schedule-job.open')?.id).toBe('job-hermes:demo-job-a');
    await render('hermes:demo-job-b');
    flushFrames();
    expect(container.querySelector('.schedule-job.open')?.id).toBe('job-hermes:demo-job-b');
    expect(scrolled).toEqual(['job-hermes:demo-job-a', 'job-hermes:demo-job-b']);
    await render();
    expect(container.querySelector('.schedule-job.open')).toBeNull();
    await render('hermes:demo-job-a');
    await render('hermes:demo-job-b');
    flushFrames();
    expect(scrolled).toEqual(['job-hermes:demo-job-a', 'job-hermes:demo-job-b', 'job-hermes:demo-job-b']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fixture.jobs = [];
    Element.prototype.scrollIntoView = originalScroll;
    vi.unstubAllGlobals();
  }
});
