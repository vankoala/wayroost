import { checkDeviceSignal } from './security/device-signal.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLOUD_ID, type AppVoice } from '../../shared/voice.js';

// The shared local voice and the opt-in app output; other outputs remain local.
// Empty local voice means the speech service's own default.

const FILE = 'voice.json';
export const VOICE_NAME = /^[a-z]{2}_[a-z]{2,20}$/;

export class VoiceSetting {
  private readonly path: string;
  private value: string;
  private app: AppVoice = { provider: 'local' };

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE);
    this.value = this.load();
  }

  private load(): string {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as { voice?: unknown; appReadAloud?: AppVoice };
      const voice = data.voice;
      const app = data.appReadAloud;
      if (app?.provider === 'elevenlabs' && typeof app.voiceId === 'string' && CLOUD_ID.test(app.voiceId) && typeof app.modelId === 'string' && CLOUD_ID.test(app.modelId)) this.app = { provider: 'elevenlabs', voiceId: app.voiceId, modelId: app.modelId };
      return typeof voice === 'string' && VOICE_NAME.test(voice) ? voice : '';
    } catch {
      return '';
    }
  }

  voice(): string {
    return this.value;
  }

  setVoice(voice: string): string {
    this.save(voice, this.app);
    return voice;
  }

  appReadAloud(): AppVoice { return { ...this.app }; }

  setAppReadAloud(choice: AppVoice): void { this.save(this.value, choice); }

  private save(voice: string, app: AppVoice): void {
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 2, voice, appReadAloud: app }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = voice;
    this.app = { ...app };
  }
}
