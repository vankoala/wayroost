import { checkDeviceSignal } from '../security/device-signal.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readLegacySafetyCommands } from '../../../shared/legacy-settings.js';

// Settings → Security → "Hermes safety commands": whether Signalbox lets
// /approve, /approvals, /yolo, /memory approval, /skills approval and /debug
// through to Hermes. Off unless the file says on, so a missing or broken file
// keeps them refused. Kept in Signalbox's state directory, written whole
// (temp file + rename).

const FILE = 'hermes-safety-commands.json';

export class SafetyCommandsSetting {
  private readonly path: string;
  private value: boolean;
  private settingsSource?: () => boolean;

  constructor(stateDir: string, pipeline = false) {
    this.path = join(stateDir, FILE);
    this.value = pipeline ? false : this.load();
    if (pipeline) this.settingsSource = () => false;
  }

  private load(): boolean {
    try {
      return readLegacySafetyCommands(readFileSync(this.path, 'utf8')).value;
    } catch {
      return false;
    }
  }

  enabled(): boolean {
    return this.settingsSource ? this.settingsSource() : this.value;
  }

  useSettingsSource(source: () => boolean): void { this.settingsSource = source; }

  setEnabled(enabled: boolean): boolean {
    if (this.settingsSource) throw new Error('config_writes_off');
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = enabled;
    return enabled;
  }
}
