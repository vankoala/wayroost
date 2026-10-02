// The browser end of voice mode: one AudioContext for recording and playback,
// the microphone (through public/voice-worklet.js), and a player that queues
// clips back to back.

const WORKLET_URL = '/voice-worklet.js';

type AudioSessionType = 'auto' | 'playback' | 'play-and-record';

let context: AudioContext | null = null;
const workletLoaded = new WeakSet<AudioContext>();

/** Can this browser record here? Needs a secure page, the mic API and AudioWorklet. */
export function micSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioWorkletNode === 'function'
  );
}

/**
 * The shared AudioContext. Call it from inside a tap or press: phones only let
 * a page start audio in response to one.
 */
export function audioContext(): AudioContext {
  if (!context || context.state === 'closed') {
    context = new AudioContext({ latencyHint: 'interactive' });
  }
  if (context.state !== 'running') void context.resume().catch(() => {});
  return context;
}

/**
 * Safari's audio session: "play-and-record" while the mic is on, "playback"
 * after, so replies come out of the speaker rather than the earpiece.
 */
function setAudioSession(type: AudioSessionType): void {
  const session = (navigator as Navigator & { audioSession?: { type: AudioSessionType } }).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // Older Safari: nothing to set.
  }
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;

  /** Starts recording. Throws if the microphone is refused or missing. */
  async start(ctx: AudioContext, onFrame: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void): Promise<void> {
    setAudioSession('play-and-record');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!workletLoaded.has(ctx)) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      workletLoaded.add(ctx);
    }
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'signalbox-mic', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (event: MessageEvent<{ pcm?: ArrayBuffer; level?: number; flushed?: boolean }>) => {
      const data = event.data;
      if (data.pcm) onFrame(data.pcm);
      if (typeof data.level === 'number') onLevel(data.level);
      if (data.flushed) this.flushed?.();
    };
    this.source.connect(this.node);
    // Silent output, but connected: browsers only run nodes that lead somewhere.
    this.node.connect(ctx.destination);
  }

  /** Stops recording after handing over the last partial frame. */
  async stop(): Promise<void> {
    const node = this.node;
    if (node) {
      await new Promise<void>((resolve) => {
        this.flushed = resolve;
        node.port.postMessage('flush');
        setTimeout(resolve, 400);
      });
    }
    this.release();
  }

  /** Stops at once and lets go of the microphone. */
  release(): void {
    this.flushed = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.node = null;
    this.source = null;
    this.stream = null;
    setAudioSession('playback');
  }
}

/** Plays clips one after another without gaps; stop() silences everything queued. */
export class Player {
  private readonly sources = new Set<AudioBufferSourceNode>();
  private endAt = 0;
  /** Bumped by stop(), so a clip still decoding when it ran is never started. */
  private generation = 0;
  private waiters: Array<() => void> = [];
  /** Told whenever a clip starts or ends, or playback stops. */
  onChange: (() => void) | null = null;

  /** Clips queued or playing. */
  pending(): number {
    return this.sources.size;
  }

  /** Resolves the next time a clip starts or ends. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
    this.onChange?.();
  }

  async play(wav: ArrayBuffer): Promise<void> {
    const ctx = audioContext();
    const generation = this.generation;
    const buffer = await ctx.decodeAudioData(wav);
    if (generation !== this.generation) return; // stopped while decoding
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.endAt);
    source.onended = () => {
      if (this.sources.delete(source)) this.notify();
    };
    this.sources.add(source);
    source.start(at);
    this.endAt = at + buffer.duration;
    this.notify();
  }

  stop(): void {
    this.generation += 1;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.endAt = 0;
    this.notify();
  }
}
