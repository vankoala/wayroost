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

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE);
    this.value = this.load();
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
    return { ...this.value, timeBoxes: [...WORKER_TIME_BOXES] };
  }

  enabled(): boolean {
    return this.value.enabled;
  }

  defaultMinutes(): number {
    return this.value.defaultMinutes;
  }

  /** Changes apply immediately, even while worker delivery is paused. */
  watch(observer: (status: WorkerUpdatesStatus) => void): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  update(patch: { enabled?: boolean; defaultMinutes?: number }): WorkerUpdatesStatus {
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
