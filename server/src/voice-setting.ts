import { checkDeviceSignal } from './security/device-signal.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppVoice } from '../../shared/voice.js';
import { readLegacyVoice } from '../../shared/legacy-settings.js';
export { VOICE_NAME } from '../../shared/legacy-settings.js';

// The shared local voice and the opt-in app output; other outputs remain local.
// Empty local voice means the speech service's own default.

const FILE = 'voice.json';

export class VoiceSetting {
  private readonly path: string;
  private value: string;
  private app: AppVoice = { provider: 'local' };
  private settingsSource?: () => { voice: string; appReadAloud: AppVoice };
  useSettingsSource(source: () => { voice: string; appReadAloud: AppVoice }): void { this.settingsSource = source; }

  constructor(stateDir: string, pipeline = false) {
    this.path = join(stateDir, FILE);
    this.value = pipeline ? '' : this.load();
    if (pipeline) this.settingsSource = () => ({ voice: '', appReadAloud: { provider: 'local' } });
  }

  private load(): string {
    try {
      const parsed = readLegacyVoice(readFileSync(this.path, 'utf8'));
      this.app = parsed.value.appReadAloud;
      return parsed.value.voice;
    } catch {
      return '';
    }
  }

  voice(): string {
    return this.settingsSource ? this.settingsSource().voice : this.value;
  }

  setVoice(voice: string): string {
    this.save(voice, this.app);
    return voice;
  }

  appReadAloud(): AppVoice { return { ...(this.settingsSource ? this.settingsSource().appReadAloud : this.app) }; }

  setAppReadAloud(choice: AppVoice): void { this.save(this.value, choice); }

  private save(voice: string, app: AppVoice): void {
    if (this.settingsSource) throw new Error('config_writes_off');
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 2, voice, appReadAloud: app }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = voice;
    this.app = { ...app };
  }
}
