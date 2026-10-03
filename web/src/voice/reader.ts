import type { TimelineItem } from '../../../shared/protocol';
import { completeSentences, speechPieces } from './text';

// Reads an agent's reply aloud as it streams in: every sentence that can no
// longer change is turned into speech and queued, a couple of clips ahead of
// what's playing. Only replies after your latest message count, so a reload
// that renames every item doesn't make it read the whole chat again.

export interface ReaderOutput {
  /** Speech for a piece of text (POST /api/voice/speak). */
  speak(text: string): Promise<ArrayBuffer>;
  stream?(text: string, signal: AbortSignal, fallback: () => void): AsyncIterable<ArrayBuffer | 'reset'>;
  reset?(piece: symbol): void;
  fallback?(): void;
  /** Queue a clip after what's already queued; resolves once it's scheduled. */
  play(audio: ArrayBuffer, piece: symbol): Promise<void>;
  /** Clips queued or playing. */
  pending(): number;
  bufferedSeconds?(): number;
  /** Resolves the next time pending() may have changed. */
  changed(): Promise<void>;
}

/** Characters read aloud per reply before handing over to the screen. */
export const MAX_SPOKEN = 4000;
export const MORE_ON_SCREEN = "There's more on screen.";
/** Clips fetched or queued ahead of the one playing. */
const AHEAD = 2;
const STREAM_AHEAD_SECONDS = 1.5;
/** Signalbox is reading for other pages too (429): try a piece again after this. */
const RETRY_MS = 800;
const RETRY = Symbol('retry');

type Assistant = Extract<TimelineItem, { kind: 'assistant' }>;

interface Place {
  offset: number;
  /** The reply's text up to `offset`, to recognise it under a new id. */
  read: string;
  /** Already there when reading started: never read, and never matched by text. */
  old?: boolean;
}

interface Fetch {
  text: string;
  piece: symbol;
  audio: Promise<ArrayBuffer | AsyncIterable<ArrayBuffer | 'reset'> | null | typeof RETRY>;
}

export class ReplyReader {
  private readonly places = new Map<string, Place>();
  private texts: string[] = [];
  private fetches: Fetch[] = [];
  private spoken = 0;
  private capped = false;
  private failures = 0;
  private pumping = false;
  private sawWork = false;
  private turnOver = false;
  private stopped = false;
  private finished = false;
  private readonly abort = new AbortController();
  private fallbackNotified = false;
  private readonly streams = new Set<AsyncIterator<ArrayBuffer | 'reset'>>();

  constructor(
    private readonly out: ReaderOutput,
    private readonly onDone: (error?: string) => void,
  ) {}

  get active(): boolean {
    return !this.stopped && !this.finished;
  }

  /** Something is being fetched, queued or played. */
  get busy(): boolean {
    return this.active && (this.texts.length > 0 || this.fetches.length > 0 || this.out.pending() > 0);
  }

  /**
   * Replies already in the conversation when reading starts (before your
   * message went): they're never read, even if a reload shuffles the timeline.
   */
  skip(items: readonly TimelineItem[]): void {
    for (const item of items) {
      if (item.kind === 'assistant') this.places.set(item.id, { offset: item.text.length, read: item.text, old: true });
    }
  }

  /** The conversation changed: its items in order, and whether the agent is still working. */
  update(items: readonly TimelineItem[], working: boolean): void {
    if (!this.active) return;
    let lastUser = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]!.kind === 'user') {
        lastUser = i;
        break;
      }
    }
    const replies = items.slice(lastUser + 1).filter((item): item is Assistant => item.kind === 'assistant');
    const present = new Set(replies.map((r) => r.id));
    let streaming = false;
    for (const reply of replies) {
      const place = this.placeFor(reply, present);
      const rest = reply.text.slice(place.offset);
      const [ready] = reply.streaming ? completeSentences(rest) : [rest];
      if (ready) {
        place.offset += ready.length;
        place.read = reply.text.slice(0, place.offset);
        this.add(ready);
      }
      if (reply.streaming) {
        // Later replies wait their turn.
        streaming = true;
        break;
      }
    }
    if (working || streaming || replies.length > 0) this.sawWork = true;
    this.turnOver = this.sawWork && !working && !streaming;
    void this.pump();
  }

  stop(): void {
    this.abort.abort();
    for (const stream of this.streams) void stream.return?.().catch(() => {});
    this.stopped = true;
    this.texts = [];
    this.fetches = [];
  }

  private placeFor(reply: Assistant, present: Set<string>): Place {
    let place = this.places.get(reply.id);
    if (place) return place;
    // The same reply under a new id (a reload): carry its place over.
    for (const [id, known] of this.places) {
      if (!known.old && !present.has(id) && known.read && reply.text.startsWith(known.read)) {
        this.places.delete(id);
        place = known;
        break;
      }
    }
    place ??= { offset: 0, read: '' };
    this.places.set(reply.id, place);
    return place;
  }

  private add(markdown: string): void {
    if (this.capped) return;
    for (const piece of speechPieces(markdown)) {
      if (this.spoken + piece.length > MAX_SPOKEN) {
        this.capped = true;
        this.texts.push(MORE_ON_SCREEN);
        return;
      }
      this.spoken += piece.length;
      this.texts.push(piece);
    }
  }

  private request(): void {
    while (this.texts.length && this.fetches.length < AHEAD) {
      const text = this.texts.shift()!;
      this.fetches.push({ text, piece: Symbol('speech piece'), audio: this.fetch(text) });
    }
  }

  private fetch(text: string): Fetch['audio'] {
    if (this.out.stream) return this.prefetch(text);
    return this.out.speak(text).then(
      (audio) => {
        this.failures = 0;
        return audio;
      },
      (err: unknown) => {
        if ((err as { status?: number } | null)?.status === 429) return RETRY;
        this.failures += 1;
        return null;
      },
    );
  }

  private async prefetch(text: string): Fetch['audio'] {
    const iterator = this.out.stream!(text, this.abort.signal, () => {
      if (!this.active || this.fallbackNotified) return;
      this.fallbackNotified = true;
      this.out.fallback?.();
    })[Symbol.asyncIterator]();
    this.streams.add(iterator);
    try {
      // Starting next() eagerly opens the following piece's POST during playback.
      const first = await iterator.next();
      const streams = this.streams;
      return (async function* () {
        try {
          if (!first.done) yield first.value;
          while (!first.done) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
          }
        } finally { streams.delete(iterator); await iterator.return?.(); }
      })();
    } catch (err) {
      this.streams.delete(iterator);
      void iterator.return?.().catch(() => {});
      if ((err as { status?: number } | null)?.status === 429) return RETRY;
      this.failures += 1;
      return null;
    }
  }

  private full(streaming: boolean): boolean {
    return streaming && this.out.bufferedSeconds ? this.out.bufferedSeconds() >= STREAM_AHEAD_SECONDS : this.out.pending() >= AHEAD;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active) {
        this.request();
        const next = this.fetches[0];
        if (!next) break;
        const audio = await next.audio;
        if (!this.active) return;
        if (audio === RETRY) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
          if (!this.active) return;
          next.audio = this.fetch(next.text);
          continue;
        }
        this.fetches.shift();
        if (this.failures >= 2) {
          this.end("Couldn't read the reply aloud.");
          return;
        }
        if (!audio) continue;
        const streaming = Symbol.asyncIterator in audio;
        while (this.active && this.full(streaming)) await this.out.changed();
        if (!this.active) return;
        try {
          if (Symbol.asyncIterator in audio) {
            for await (const clip of audio) {
              if (!this.active) return;
              if (clip === 'reset') { this.out.reset?.(next.piece); continue; }
              while (this.active && this.full(true)) await this.out.changed();
              if (!this.active) return;
              await this.out.play(clip, next.piece);
            }
          } else await this.out.play(audio, next.piece);
          this.failures = 0;
        } catch (err) {
          if ((err as { status?: number }).status === 429) {
            this.fetches.unshift({ ...next, audio: this.fetch(next.text) });
            await new Promise(resolve => setTimeout(resolve, RETRY_MS));
          }
          else this.failures += 1;
          if (this.failures >= 2) { this.end("Couldn't read the reply aloud."); return; }
        }
      }
    } finally {
      this.pumping = false;
    }
    if (this.active && this.turnOver && !this.texts.length && !this.fetches.length) {
      while (this.active && this.out.pending() > 0) await this.out.changed();
      // More may have arrived while the last clip played.
      if (this.active && this.turnOver && !this.texts.length && !this.fetches.length && !this.pumping) this.end();
    }
  }

  private end(error?: string): void {
    if (!this.active) return;
    this.finished = true;
    this.onDone(error);
  }
}
