import { useEffect, useState } from 'react';
import type { ScheduleList, ScheduleOverview } from '../../shared/protocol';
import { api } from './api';
import { useStore } from './store';

// Scheduled-jobs data for the home page's Scheduled tab (and its badge): loaded on open,
// refreshed when Hermes says jobs changed (schedules_changed) and once a minute.

const POLL_MS = 60_000;

function usePolled<T>(load: () => Promise<T>, enabled = true): T | null {
  const version = useStore((s) => s.schedulesVersion);
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = () =>
      load().then(
        (d) => live && setData(d),
        () => {}, // Hermes off, signed out, older server: nothing to show
      );
    void run();
    const timer = setInterval(run, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, enabled]);
  return data;
}

export const useScheduleOverview = () => usePolled<ScheduleOverview>(() => api.scheduleOverview());
export const useScheduleList = (enabled: boolean) => usePolled<ScheduleList>(() => api.schedules(), enabled);
