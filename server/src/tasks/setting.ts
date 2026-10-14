import { checkDeviceSignal } from '../security/device-signal.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKER_TIME_BOXES, type WorkerUpdatesStatus } from '../../../shared/protocol.js';

// Settings → Project bridge → "Worker updates": whether Signalbox tells a Hermes
// chat when a Paseo worker it started finishes, fails, stops, needs you, or runs
// past its time box, and the time box for workers that don't name their own.
// On unless the file says off. Kept in Signalbox's state directory, written
// whole (temp file + rename).

const FILE = 'worker-updates.json';
export const DEFAULT_TIME_BOX_MINUTES = 60;

export class WorkerUpdatesSetting {
  private readonly path: string;
  private value: Omit<WorkerUpdatesStatus, 'timeBoxes'>;
  private readonly observers = new Set<(status: WorkerUpdatesStatus) => void>();
  private settingsSource?: () => Omit<WorkerUpdatesStatus, 'timeBoxes'>;
  useSettingsSource(source: () => Omit<WorkerUpdatesStatus, 'timeBoxes'>): void { this.settingsSource = source; }
  refreshSettings(): void { if (this.state() !== 'unknown') for (const observer of this.observers) observer(this.status()); }

  constructor(stateDir: string, pipeline = false) {
    this.path = join(stateDir, FILE);
    this.value = pipeline ? { enabled: false, defaultMinutes: DEFAULT_TIME_BOX_MINUTES } : this.load();
    if (pipeline) this.settingsSource = () => ({ enabled: false, state: 'unknown', defaultMinutes: DEFAULT_TIME_BOX_MINUTES });
  }

  private load(): Omit<WorkerUpdatesStatus, 'timeBoxes'> {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { enabled?: unknown; defaultMinutes?: unknown };
      const minutes = Number(raw.defaultMinutes);
      return {
        enabled: raw.enabled !== false,
        defaultMinutes: (WORKER_TIME_BOXES as readonly number[]).includes(minutes) ? minutes : DEFAULT_TIME_BOX_MINUTES,
      };
    } catch {
      return { enabled: true, defaultMinutes: DEFAULT_TIME_BOX_MINUTES };
    }
  }

  status(): WorkerUpdatesStatus {
    return { ...(this.settingsSource ? this.settingsSource() : this.value), timeBoxes: [...WORKER_TIME_BOXES] };
  }

  enabled(): boolean {
    return this.status().enabled;
  }

  state(): NonNullable<WorkerUpdatesStatus['state']> {
    const status = this.status();
    return status.state ?? (status.enabled ? 'verified-on' : 'verified-off');
  }

  defaultMinutes(): number {
    return this.status().defaultMinutes;
  }

  /** Changes apply immediately, even while worker delivery is paused. */
  watch(observer: (status: WorkerUpdatesStatus) => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  update(patch: { enabled?: boolean; defaultMinutes?: number }): WorkerUpdatesStatus {
    if (this.settingsSource) throw new Error('config_writes_off');
    checkDeviceSignal();
    const next = { ...this.value, ...patch };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = next;
    for (const observer of this.observers) observer(this.status());
    return this.status();
  }
}
