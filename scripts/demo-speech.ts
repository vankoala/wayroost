// A stand-in for the speech service (speech/signalbox-speech.py) in the demo and
// the UI check: it "hears" a fixed sentence and "reads aloud" with silence, and
// counts what arrived so a check can tell the audio really made it through.

import type { SpeechService } from '../server/src/speech.js';

export const DEMO_TRANSCRIPT = "Can you check whether last night's backup finished?";

/** Mono 16-bit silence at 24 kHz, as a WAV file. */
function silence(seconds: number): Buffer {
  const rate = 24000;
  const bytes = Math.round(rate * seconds) * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(bytes, 40);
  return wav;
}

export class DemoSpeech implements SpeechService {
  /** Audio bytes received so far. */
  heard = 0;
  /** Text read aloud so far. */
  spoken: string[] = [];

  async health() {
    return { voices: ['af_bella', 'af_heart', 'am_michael', 'bf_emma', 'bm_george'], defaultVoice: 'af_heart' };
  }

  async transcribe(pcm: Buffer) {
    this.heard += pcm.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { text: DEMO_TRANSCRIPT, ms: 140 };
  }

  async speak(text: string) {
    this.spoken.push(text);
    return silence(Math.min(4, 0.5 + text.length / 25));
  }
}
