import type { PowerMonitor } from 'electron';
export type Presence = 'active' | 'idle' | 'locked';
export function monitorPresence(send: (state: Presence) => Promise<unknown>, powerMonitor: Pick<PowerMonitor, 'on' | 'removeListener' | 'getSystemIdleTime'>) {
  let locked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const state = locked ? 'locked' : powerMonitor.getSystemIdleTime() >= 60 ? 'idle' : 'active';
      // The server loses presence on revocation or restart; resend even when the state is unchanged.
      void send(state).catch(() => {});
    }, 500);
  };
  const lock = () => { locked = true; update(); };
  const unlock = () => { locked = false; update(); };
  powerMonitor.on('lock-screen', lock); powerMonitor.on('unlock-screen', unlock);
  const interval = setInterval(update, 5000); update();
  return () => { clearInterval(interval); clearTimeout(timer); powerMonitor.removeListener('lock-screen', lock); powerMonitor.removeListener('unlock-screen', unlock); };
}
