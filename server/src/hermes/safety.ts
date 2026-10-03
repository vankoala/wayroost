import { checkDeviceSignal } from '../security/device-signal.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Settings → Security → "Hermes safety commands": whether Signalbox lets
// /approve, /approvals, /yolo, /memory approval, /skills approval and /debug
// through to Hermes. Off unless the file says on, so a missing or broken file
// keeps them refused. Kept in Signalbox's state directory, written whole
// (temp file + rename).

const FILE = 'hermes-safety-commands.json';

export class SafetyCommandsSetting {
  private readonly path: string;
  private value: boolean;

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE);
    this.value = this.load();
  }

  private load(): boolean {
    try {
      return (JSON.parse(readFileSync(this.path, 'utf8')) as { enabled?: unknown }).enabled === true;
    } catch {
      return false;
    }
  }

  enabled(): boolean {
    return this.value;
  }

  setEnabled(enabled: boolean): boolean {
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = enabled;
    return enabled;
  }
}
