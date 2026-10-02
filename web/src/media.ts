import { fetchMedia } from './api';

// Images from your machine that an agent showed. Their links are signed by the
// server and need the API headers, so they're fetched here and shown as blob:
// URLs this module made; nothing else is ever fetched or used as an image
// source. Only images near the screen load, and a few dozen stay in memory.

const MEDIA_URL = /^\/api\/media\/(?:hermes|paseo)\/[^/?#\s]+\?p=[\w-]+&s=[\w-]+$/;

/** A link the server signed for an image, and nothing else. */
export const isMediaUrl = (url: string) => MEDIA_URL.test(url);

const MAX_ENTRIES = 30;
const MAX_BYTES = 120 * 1024 * 1024;
/** A failed image isn't asked for again this soon. */
const RETRY_AFTER_MS = 60_000;

interface Entry {
  promise: Promise<string>;
  url?: string;
  bytes: number;
  failedAt?: number;
}

// Map order is the LRU order, oldest first.
const entries = new Map<string, Entry>();

function touch(src: string, entry: Entry) {
  entries.delete(src);
  entries.set(src, entry);
  let bytes = [...entries.values()].reduce((sum, e) => sum + e.bytes, 0);
  for (const [key, old] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    if (old === entry) continue;
    entries.delete(key);
    bytes -= old.bytes;
    if (old.url) URL.revokeObjectURL(old.url);
  }
}

/** The blob: URL for an image already loaded (and keeps it around a little longer). */
export function cachedMedia(src: string): string | undefined {
  const entry = entries.get(src);
  if (!entry?.url) return undefined;
  touch(src, entry);
  return entry.url;
}

/** Load an image once; resolves to a blob: URL, or rejects with a message to show. */
export function loadMedia(src: string): Promise<string> {
  const hit = entries.get(src);
  if (hit && !(hit.failedAt && Date.now() - hit.failedAt > RETRY_AFTER_MS)) {
    touch(src, hit);
    return hit.promise;
  }
  if (!isMediaUrl(src)) return Promise.reject(new Error('Image unavailable.'));
  const entry: Entry = { bytes: 0, promise: Promise.resolve('') };
  entry.promise = fetchMedia(src).then(
    (blob) => {
      entry.url = URL.createObjectURL(blob);
      entry.bytes = blob.size;
      touch(src, entry);
      return entry.url;
    },
    (err: Error) => {
      entry.failedAt = Date.now();
      throw new Error(err.message);
    },
  );
  entry.promise.catch(() => {}); // callers handle it; this copy is just kept
  touch(src, entry);
  return entry.promise;
}

// One observer per scrolling area, loading a little before an image scrolls in.
const observers = new WeakMap<Element, IntersectionObserver>();
let viewportObserver: IntersectionObserver | undefined;
const waiting = new WeakMap<Element, () => void>();

function observerFor(root: Element | null): IntersectionObserver {
  const existing = root ? observers.get(root) : viewportObserver;
  if (existing) return existing;
  const observer = new IntersectionObserver(
    (seen, self) => {
      for (const entry of seen) {
        if (!entry.isIntersecting) continue;
        self.unobserve(entry.target);
        const run = waiting.get(entry.target);
        waiting.delete(entry.target);
        run?.();
      }
    },
    { root, rootMargin: '600px 0px' },
  );
  if (root) observers.set(root, observer);
  else viewportObserver = observer;
  return observer;
}

/** Run `load` once `el` is near the screen. Returns a function that cancels it. */
export function whenNear(el: Element, load: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    load();
    return () => {};
  }
  const observer = observerFor(el.closest('.timeline'));
  waiting.set(el, load);
  observer.observe(el);
  return () => {
    observer.unobserve(el);
    waiting.delete(el);
  };
}

function showImage(el: HTMLElement, url: string) {
  const img = document.createElement('img');
  img.src = url;
  img.alt = el.dataset.alt ?? '';
  img.decoding = 'async';
  el.replaceChildren(img);
  el.classList.add('ready');
}

function showError(el: HTMLElement, message: string) {
  el.replaceChildren(document.createTextNode(message));
  el.classList.add('failed');
  el.setAttribute('aria-disabled', 'true');
}

/**
 * Fill in the image placeholders the markdown renderer left (see markdown.ts).
 * Returns a function that stops loading any that haven't started.
 */
export function hydrateMedia(root: HTMLElement | null): () => void {
  if (!root) return () => {};
  const stops: Array<() => void> = [];
  for (const el of root.querySelectorAll<HTMLElement>('.md-media[data-media]')) {
    if (el.classList.contains('ready') || el.classList.contains('failed')) continue;
    const src = el.dataset.media ?? '';
    const ready = cachedMedia(src);
    if (ready) {
      showImage(el, ready);
      continue;
    }
    stops.push(
      whenNear(el, () =>
        loadMedia(src).then(
          (url) => el.isConnected && showImage(el, url),
          (err: Error) => el.isConnected && showError(el, err.message),
        ),
      ),
    );
  }
  return () => stops.forEach((stop) => stop());
}
