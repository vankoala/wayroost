export type VoiceProvider = 'local' | 'elevenlabs';
export interface AppVoice {
  provider: VoiceProvider;
  voiceId?: string;
  modelId?: string;
}
export interface CloudVoice { id: string; name: string; category: string; preview: boolean }
export interface CloudModel { id: string; name: string }
export type CloudVoiceErrorCode = 'auth' | 'quota' | 'rate-limit' | 'unreachable' | 'timeout' | 'invalid' | 'failed';
export interface CloudVoices { voices: CloudVoice[]; models: CloudModel[] }
export const CLOUD_ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const CLOUD_FORMATS = ['pcm_24000', 'mp3_44100_128'] as const;
export type CloudFormat = typeof CLOUD_FORMATS[number];
/** A reset replaces partial cloud audio with the complete local rendering. */
export type SpeechFrame =
  | { type: 'start' | 'reset'; provider: VoiceProvider; voice: string; format: 'pcm_24000' | 'wav'; reason?: CloudVoiceErrorCode }
  | { type: 'audio'; data: string }
  | { type: 'end'; provider: VoiceProvider; voice: string }
  | { type: 'error'; message: string };
