import type { TimelineItem } from '../../../shared/protocol';
import { completeSentences, speechPieces } from './text';

// Reads an agent's reply aloud as it streams in: every sentence that can no
// longer change is turned into speech and queued, a couple of clips ahead of
// what's playing. Only replies after your latest message count, so a reload
// that renames every item doesn't make it read the whole chat again.

export interface ReaderOutput {
  /** Speech for a piece of text (POST /api/voice/speak). */
  speak(text: string): Promise<ArrayBuffer>;
  /** Queue a clip after what's already queued; resolves once it's scheduled. */
  play(audio: ArrayBuffer): Promise<void>;
  /** Clips queued or playing. */
  pending(): number;
  /** Resolves the next time pending() may have changed. */
  changed(): Promise<void>;
}

/** Characters read aloud per reply before handing over to the screen. */
export const MAX_SPOKEN = 4000;
export const MORE_ON_SCREEN = "There's more on screen.";
/** Clips fetched or queued ahead of the one playing. */
const AHEAD = 2;
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
  audio: Promise<ArrayBuffer | null | typeof RETRY>;
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
      this.fetches.push({ text, audio: this.fetch(text) });
    }
  }

  private fetch(text: string): Promise<ArrayBuffer | null | typeof RETRY> {
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
        while (this.active && this.out.pending() >= AHEAD) await this.out.changed();
        if (!this.active) return;
        try {
          await this.out.play(audio);
        } catch {
          // A clip the browser can't decode: skip it.
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
