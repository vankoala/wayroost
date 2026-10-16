import { useStore } from '../store.js';

export function MaintenanceBanner() {
  const held = useStore((s) => s.maintenance);
  return held ? <div className="maintenance-banner" role="status">Maintenance: new work paused</div> : null;
}
