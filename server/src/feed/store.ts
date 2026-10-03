import { checkDeviceSignal } from '../security/device-signal.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { INVISIBLE } from '../../../shared/invisible.js';
import {
  FEED_KINDS,
  PROACTIVITY_LEVELS,
  type FeedCard,
  type FeedSource,
  type FeedStatus,
  type ProactivityLevel,
} from '../../../shared/protocol.js';

// For you: the cards Hermes' pulse (and agents on the bridge) leave for you, and
// your choices about them. Kept in Signalbox's state directory as one small JSON
// file, written whole (temp file + rename) on every change.

const FILE = 'feed.json';
const MAX_CARDS = 300;
const MAX_PER_INGEST = 20;
/** Done and turned-down cards are kept this long, so a later run doesn't bring them back. */
const KEEP_CLOSED_MS = 14 * 86_400_000;
const KEEP_ANY_MS = 30 * 86_400_000;
const MAX_LESS_LIKE = 30;
const MAX_NOTIFIED = 200;

export interface StoredSettings {
  level: ProactivityLevel;
  quietHours: { start: string; end: string } | null;
  push: { approvals: boolean; cards: boolean };
  lessLike: Array<{ topic: string; example: string; at: number }>;
}

const DEFAULT_SETTINGS: StoredSettings = {
  level: 'normal',
  quietHours: { start: '21:00', end: '07:00' },
  push: { approvals: true, cards: false },
  lessLike: [],
};

interface FeedFile {
  cards: FeedCard[];
  settings: StoredSettings;
  /** Approvals already sent to the phone, so a restart doesn't send them again. */
  notified: string[];
}

/** One line of plain text: no hidden characters or links, whitespace collapsed, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const clean = text
    .replace(INVISIBLE, ' ')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link]')
    .replace(/\s+/g, ' ')
    .trim();
  // Counted in characters, so an emoji is never cut in half.
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const Text = (max: number) => z.string().transform((s) => oneLine(s, max));

/** A card as the pulse (or an agent) sends it. Unknown fields are dropped. */
export const CardInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z-]{0,15}:[\w.:@+\-/=]{1,120}$/, 'key must look like "mail:<id>"'),
  kind: z.enum(FEED_KINDS),
  title: Text(100).pipe(z.string().min(1)),
  detail: Text(400).optional(),
  action: Text(400).optional(),
  topic: Text(40).optional(),
});
export type CardInput = z.infer<typeof CardInput>;

export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

const SettingsShape = z.object({
  level: z.enum(PROACTIVITY_LEVELS).catch('normal'),
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable().catch(DEFAULT_SETTINGS.quietHours),
  push: z.object({ approvals: z.boolean(), cards: z.boolean() }).catch(DEFAULT_SETTINGS.push),
  lessLike: z
    .array(z.object({ topic: z.string(), example: z.string(), at: z.number() }))
    .catch([]),
});

const idFor = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export class FeedStore {
  private file: FeedFile;
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(stateDir, FILE);
    this.file = this.load();
  }

  private load(): FeedFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FeedFile>;
      const settings = SettingsShape.safeParse(raw.settings ?? {});
      return {
        cards: Array.isArray(raw.cards) ? raw.cards.filter((c) => c && typeof c.key === 'string') : [],
        settings: settings.success ? settings.data : { ...DEFAULT_SETTINGS },
        notified: Array.isArray(raw.notified) ? raw.notified.filter((n) => typeof n === 'string') : [],
      };
    } catch {
      return { cards: [], settings: { ...DEFAULT_SETTINGS, lessLike: [] }, notified: [] };
    }
  }

  private save(): void {
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Cards to show, newest first: everything not done, turned down or put off. */
  visible(): FeedCard[] {
    return this.file.cards
      .filter((c) => c.status === 'new' || c.status === 'seen')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  all(): FeedCard[] {
    return [...this.file.cards];
  }

  get(id: string): FeedCard | undefined {
    return this.file.cards.find((c) => c.id === id);
  }

  settings(): StoredSettings {
    return this.file.settings;
  }

  /**
   * Add or update cards, matched by key. A card you finished or turned down
   * stays that way; one you put off stays hidden until its time.
   */
  ingest(source: FeedSource, inputs: CardInput[]): { created: FeedCard[]; updated: FeedCard[]; removed: string[] } {
    const created: FeedCard[] = [];
    const updated: FeedCard[] = [];
    const now = this.now();
    for (const input of inputs.slice(0, MAX_PER_INGEST)) {
      const existing = this.file.cards.find((c) => c.key === input.key);
      if (!existing) {
        const card: FeedCard = {
          id: idFor(input.key),
          key: input.key,
          source,
          kind: input.kind,
          title: input.title,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.action ? { action: input.action } : {}),
          ...(input.topic ? { topic: input.topic } : {}),
          createdAt: now,
          updatedAt: now,
          status: 'new',
        };
        this.file.cards.push(card);
        created.push(card);
        continue;
      }
      if (existing.status === 'done' || existing.status === 'dismissed') continue;
      const changed =
        existing.title !== input.title ||
        (existing.detail ?? '') !== (input.detail ?? '') ||
        (existing.action ?? '') !== (input.action ?? '') ||
        (existing.topic ?? '') !== (input.topic ?? '') ||
        existing.kind !== input.kind;
      if (!changed) continue;
      existing.kind = input.kind;
      existing.title = input.title;
      if (input.detail) existing.detail = input.detail;
      else delete existing.detail;
      if (input.action) existing.action = input.action;
      else delete existing.action;
      if (input.topic) existing.topic = input.topic;
      else delete existing.topic;
      existing.updatedAt = now;
      updated.push(existing);
    }
    let removed: string[] = [];
    if (created.length || updated.length) {
      removed = this.forget();
      this.save();
    }
    return { created, updated, removed };
  }

  /** Change a card's status; returns it, or undefined if there's no such card. */
  setStatus(
    id: string,
    status: FeedStatus,
    extra: { laterUntil?: number; chat?: FeedCard['chat'] } = {},
  ): FeedCard | undefined {
    checkDeviceSignal();
    const card = this.get(id);
    if (!card) return undefined;
    card.status = status;
    card.updatedAt = this.now();
    if (status === 'later' && extra.laterUntil) card.laterUntil = extra.laterUntil;
    else delete card.laterUntil;
    if (extra.chat) card.chat = extra.chat;
    this.save();
    return card;
  }

  /**
   * Close the card with this key because what it was about is over (an overdue
   * worker finished). Only an open card (new, seen or put off) changes; one you
   * finished or turned down stays as you left it. Returns the card if it changed.
   */
  close(key: string): FeedCard | undefined {
    const card = this.file.cards.find((c) => c.key === key);
    if (!card || !(card.status === 'new' || card.status === 'seen' || card.status === 'later')) return undefined;
    const previous = { ...card };
    card.status = 'done';
    card.updatedAt = this.now();
    delete card.laterUntil;
    try { this.save(); }
    catch (error) {
      // Keep the card open so a later close retries persistence before clearing its task key.
      Object.assign(card, previous);
      throw error;
    }
    return card;
  }

  /** New cards become seen once you've opened For you. Returns the ones that changed. */
  markSeen(): FeedCard[] {
    checkDeviceSignal();
    const changed = this.file.cards.filter((c) => c.status === 'new');
    if (!changed.length) return [];
    for (const card of changed) card.status = 'seen';
    this.save();
    return changed;
  }

  /** Put-off cards whose time has come back as new. Returns them. */
  wakeLater(): FeedCard[] {
    const now = this.now();
    const woken = this.file.cards.filter((c) => c.status === 'later' && (c.laterUntil ?? 0) <= now);
    if (!woken.length) return [];
    for (const card of woken) {
      card.status = 'new';
      card.updatedAt = now;
      delete card.laterUntil;
    }
    this.save();
    return woken;
  }

  updateSettings(patch: Partial<StoredSettings>): StoredSettings {
    checkDeviceSignal();
    this.file.settings = { ...this.file.settings, ...patch };
    this.save();
    return this.file.settings;
  }

  addLessLike(topic: string, example: string): void {
    checkDeviceSignal();
    const clean = oneLine(topic, 40);
    if (!clean) return;
    const rest = this.file.settings.lessLike.filter((l) => l.topic.toLowerCase() !== clean.toLowerCase());
    this.file.settings.lessLike = [{ topic: clean, example: oneLine(example, 100), at: this.now() }, ...rest].slice(
      0,
      MAX_LESS_LIKE,
    );
    this.save();
  }

  removeLessLike(topic: string): void {
    checkDeviceSignal();
    const before = this.file.settings.lessLike.length;
    this.file.settings.lessLike = this.file.settings.lessLike.filter(
      (l) => l.topic.toLowerCase() !== topic.trim().toLowerCase(),
    );
    if (this.file.settings.lessLike.length !== before) this.save();
  }

  /** Record that an approval went to the phone; false if it already had. */
  markNotified(key: string): boolean {
    if (this.file.notified.includes(key)) return false;
    this.file.notified = [...this.file.notified, key].slice(-MAX_NOTIFIED);
    this.save();
    return true;
  }

  /** Forget old cards (30 days, closed ones after 14, at most 300); returns the ids that went. */
  prune(): string[] {
    checkDeviceSignal();
    const removed = this.forget();
    if (removed.length) this.save();
    return removed;
  }

  private forget(): string[] {
    const now = this.now();
    let cards = this.file.cards.filter((c) => {
      const age = now - c.updatedAt;
      if (age > KEEP_ANY_MS) return false;
      return !((c.status === 'done' || c.status === 'dismissed') && age > KEEP_CLOSED_MS);
    });
    if (cards.length > MAX_CARDS) {
      cards = cards.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CARDS);
    }
    const kept = new Set(cards.map((c) => c.id));
    const removed = this.file.cards.filter((c) => !kept.has(c.id)).map((c) => c.id);
    this.file.cards = cards;
    return removed;
  }
}
