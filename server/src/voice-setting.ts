import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Settings → Voice: the one voice used everywhere, so every device reads replies
// in it and Hermes Phone (calls and car calls) speaks with it too. Kept in
// Signalbox's state directory, written whole (temp file + rename). Empty until
// someone picks one, which means the speech service's own default.

const FILE = 'voice.json';
export const VOICE_NAME = /^[a-z]{2}_[a-z]{2,20}$/;

export class VoiceSetting {
  private readonly path: string;
  private value: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, FILE);
    this.value = this.load();
  }

  private load(): string {
    try {
      const voice = (JSON.parse(readFileSync(this.path, 'utf8')) as { voice?: unknown }).voice;
      return typeof voice === 'string' && VOICE_NAME.test(voice) ? voice : '';
    } catch {
      return '';
    }
  }

  voice(): string {
    return this.value;
  }

  setVoice(voice: string): string {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ voice }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.value = voice;
    return voice;
  }
}
