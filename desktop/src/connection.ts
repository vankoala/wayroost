import type { Link } from './tray-state.js';
/** What AppLink drives in the app; main.ts wires these to the tray and the main window. */
export interface AppLinkEffects {
  /** The link changed: repaint the tray. */
  changed(): void;
  /** Try the app page again; a load already under way is left to finish. */
  retry(): void;
}
/**
 * The app's own view of the server, from two sources kept apart: the approval socket and the window's page.
 * A failed page load reads as down until a page loads again, whatever the socket does meanwhile: a socket
 * that opens doesn't make a page that failed work, and one that closes doesn't make it any less down.
 *
 * It also tracks recovery: while the rescue page stands in for the main window, any sign that the server
 * answers again (the socket reopening, an authenticated snapshot landing) retries the app page, and the
 * page loading (dom-ready in main.ts) brings the main window back.
 */
export class AppLink {
  private socket: Exclude<Link, 'down'> = 'connecting';
  private failed = false;
  private view: 'app' | 'pairing' | 'recovery' | 'setup' = 'app';
  /** Counts recoveries, so a step that waited can tell whether the recovery it belongs to is still the one under way. */
  private recoveries = 0;
  /** The recovery whose rescue page was put up (presentRescue ran its present step); 0 for none yet. */
  private presentedFor = 0;
  constructor(private readonly effects: AppLinkEffects) {}
  get link(): Link { return this.failed ? 'down' : this.socket; }
  /** The one state that decides which window the app presents. */
  get surface() { return this.view; }
  /** Whether the rescue page stands in for the main window. */
  get recovering() { return this.view === 'recovery'; }
  /** Starts recovery, or joins the one under way; returns its ticket for stillRecovering(). */
  startRecovery(): number {
    if (!this.recovering) { this.view = 'recovery'; this.recoveries += 1; }
    return this.recoveries;
  }
  endRecovery(surface: 'app' | 'pairing' = 'app') { this.view = surface; }
  startSetup() { if (!this.recovering) this.view = 'setup'; }
  /** Whether the recovery a startRecovery() ticket names is still under way (not ended, not replaced by a later one). */
  stillRecovering(ticket: number) { return this.recovering && ticket === this.recoveries; }
  /** Marks the rescue page as put up for the recovery a ticket names, while it is still under way. */
  rescuePresented(ticket: number) { if (this.stillRecovering(ticket)) this.presentedFor = ticket; }
  /** Whether the recovery under way has put its rescue page up yet (it may still be loading). */
  get presented() { return this.recovering && this.presentedFor === this.recoveries; }
  socketOpened() { this.socket = 'connected'; this.effects.changed(); this.answered(); }
  socketClosed() { this.socket = 'reconnecting'; this.effects.changed(); }
  /** The server answered an authenticated request: while recovering, the app page is worth another try. */
  answered() { if (this.recovering) this.effects.retry(); }
  pageFailed() { this.failed = true; this.effects.changed(); }
  /** An app page loaded: the only thing that clears a page failure. */
  pageLoaded() { if (!this.failed) return; this.failed = false; this.effects.changed(); }
}
/**
 * Puts the rescue page up for a recovery. Opening the page can take a while (its first load); if the app came
 * back meanwhile and recovery ended, the page stays as it is: presenting it then would hide a working app
 * behind a rescue page that no recovery is watching, so nothing would ever bring the app back. `instead` runs
 * in that case (someone asked for the app: it comes forward as it is now).
 */
export async function presentRescue<P>(link: AppLink, open: () => Promise<P>, present: (page: P) => void, instead?: () => void): Promise<void> {
  const ticket = link.startRecovery();
  const page = await open();
  if (link.stillRecovering(ticket)) { link.rescuePresented(ticket); present(page); } else instead?.();
}
/**
 * Whether an app page loading during recovery brings the main window forward. It does when the rescue page is
 * up, and when the rescue page was never put up (still loading) but would come to the front once it was: a
 * normal start whose first load failed has no visible window at all, so ending recovery quietly would leave
 * both windows hidden. The outcome then doesn't depend on which load finished first. A rescue page that was
 * put up and then closed, or one a hidden start keeps in the tray, leaves the main window as it is.
 */
export function restoreShowsApp(state: { rescueVisible: boolean; rescuePresented: boolean; rescueWouldFront: boolean }): boolean {
  return state.rescueVisible || (!state.rescuePresented && state.rescueWouldFront);
}
/**
 * One shared creation for something every caller needs ready: callers that arrive while it is under way wait
 * for the same one instead of using it half made. A failed creation is forgotten, so the next call tries again.
 */
export function shared<T>(create: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => made ??= create().catch((error: unknown) => { made = undefined; throw error; });
}
/** What AppPage drives in the app; main.ts wires these to the main window, the rescue page and the tray. */
export interface AppPageEffects {
  /** Load the app's start page again (a scheduled reload). */
  load(): void;
  /** The app page failed while nothing was recovering: put the rescue page up. */
  rescue(): void;
  /** An app page loaded during recovery: bring the main window back (see restoreShowsApp), or just end recovery. */
  restore(): void;
  /** An app page loaded: worth asking the supervisor how things are. */
  loaded(): void;
}
/**
 * The main window's page, from its main-frame events. Only an app document that committed as a real page
 * (did-navigate) counts as loaded: when a load fails, Chromium commits an error document for the same URL and
 * emits dom-ready for it, so dom-ready and getURL() alone can't tell a working page from its error page.
 * Until an app page loads, failed loads retry with back-off (2 s to 30 s), so a sign-in start before WSL and
 * the server are up ends with a working window without anyone pressing Open.
 */
export class AppPage {
  /** What the latest main-frame commit was: an app page, another page, or an error document. */
  private document: 'none' | 'app' | 'other' | 'failed' = 'none';
  private delay = 2000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private readonly link: AppLink, private readonly effects: AppPageEffects) {}
  /** Whether a reload is scheduled. */
  get reloading() { return this.timer !== undefined; }
  /** did-navigate: a main-frame document committed without a network error; `app` when it is on the app's origin. */
  navigated(app: boolean) { this.document = app ? 'app' : 'other'; }
  /** did-fail-load in the main frame. A cancelled load (-3) leaves the page it was replacing as it was. */
  failed(code: number) {
    if (code === -3) return;
    this.document = 'failed';
    this.link.pageFailed();
    if (!this.link.recovering) this.effects.rescue();
    this.schedule();
  }
  /** dom-ready: acts only for an app document that loaded, never for an error document or another page. */
  domReady() {
    if (this.document !== 'app') return;
    clearTimeout(this.timer); this.timer = undefined; this.delay = 2000;
    this.link.pageLoaded();
    if (this.link.recovering) this.effects.restore();
    this.effects.loaded();
  }
  /** Quitting: no more reloads. */
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.effects.load(); }, this.delay);
    this.delay = Math.min(this.delay * 2, 30000);
  }
}
