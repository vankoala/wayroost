import type {
  Approval,
  FeedAction,
  FeedActionResult,
  FeedCard,
  FeedList,
  FeedSettings,
  FeedSource,
  FeedStatus,
  ProactivityLevel,
  ScheduleJob,
  ScheduleList,
  ServerEvent,
} from '../../../shared/protocol.js';
import type { EventHub } from '../hub.js';
import type { Schedules } from '../schedules.js';
import { UserFacingError, type HermesSource } from '../sources.js';
import { oneLine, type CardInput, type FeedStore, type StoredSettings } from './store.js';
import type { PushMessage, PushSender, PushSubscriptionInput } from './push.js';
import { shadowBackground, type BackgroundGate } from '../background.js';
import type { Devices } from '../devices.js';

// For you: Hermes' pulse (the 7am brief and the daytime checks) posts cards
// through the bridge listener; you act on them here. "Do it" starts a Hermes
// chat with the card's request, "Not now" hides it for a few hours, "Less like
// this" turns the topic down for future runs. Phone notifications go out for
// new cards (if you want them) and for agents waiting on you, outside quiet hours.
// The proactivity level pauses, resumes and reschedules the pulse jobs in Hermes.

export const BRIEF_JOB = 'pulse-morning-brief';
export const SCOUT_JOB = 'pulse-scout';
/** The daytime check's schedule per level (the brief stays at 7:00). */
export const SCOUT_SCHEDULES: Record<'normal' | 'high', string> = {
  normal: '0 10,12,14,16,18,20 * * *',
  high: '0 9-21 * * *',
};
const LATER_MS = 3 * 3_600_000;
const RECENT_MS = 7 * 86_400_000;
const SOURCE_LABELS: Record<FeedSource, string> = { brief: 'morning brief', scout: 'daytime check', agent: 'an agent' };
const SOURCE_NAMES = { hermes: 'Hermes', paseo: 'Paseo' } as const;

export interface FeedLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface FeedDeps {
  background?: BackgroundGate;
  store: FeedStore;
  hub: EventHub;
  hermes: Pick<HermesSource, 'createConversation'>;
  /** Hermes' scheduled jobs, to apply the proactivity level. */
  schedules?: Pick<Schedules, 'list' | 'update' | 'setPaused'>;
  /** Phone notifications; absent when Signalbox isn't on https. */
  push?: PushSender;
  log: FeedLog;
  now?: () => number;
  /** For quiet hours and "Do it" dates; defaults to the machine's zone. */
  timeZone?: string;
}

/** What the pulse reads back before each run (GET /pulse/v1/preferences on the bridge). */
export interface PulsePreferences {
  level: ProactivityLevel;
  quietHours: { start: string; end: string } | null;
  lessLike: Array<{ topic: string; example: string }>;
  /** Cards from the last week, so a run doesn't repeat what's already there or was turned down. */
  cards: Array<{ key: string; status: FeedStatus; title: string; source: FeedSource }>;
  /** Keys you marked done in the last week (open loops get ticked off). */
  done: string[];
}

export class Feed {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pulseFound = false;
  private lastLook = 0;
  private readonly now: () => number;

  constructor(private readonly deps: FeedDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    (this.deps.background ?? shadowBackground).run(() => {
      this.deps.hub.observe((event) => this.observe(event));
      this.timer = setInterval(() => this.wake(), 60_000);
      this.timer.unref?.();
      void this.findPulse();
    });
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ---- Reading ------------------------------------------------------------------

  async list(): Promise<FeedList> {
    // Hermes may not have been up when Signalbox started (a reboot): look again, at most every
    // 30 s, waiting no more than 2 s for the answer (a later visit picks up a slow one).
    if (!this.pulseFound && this.now() - this.lastLook > 30_000) {
      await Promise.race([this.findPulse(), new Promise((done) => setTimeout(done, 2_000).unref?.())]);
    }
    return { cards: this.deps.store.visible(), settings: this.settings() };
  }

  settings(): FeedSettings {
    const s = this.deps.store.settings();
    return {
      level: s.level,
      quietHours: s.quietHours,
      push: s.push,
      lessLike: s.lessLike,
      pushAvailable: Boolean(this.deps.push),
      pushDevices: this.deps.push?.devices() ?? 0,
      pulseFound: this.pulseFound,
    };
  }

  preferences(): PulsePreferences {
    const s = this.deps.store.settings();
    const since = this.now() - RECENT_MS;
    const recent = this.deps.store.all().filter((c) => c.updatedAt >= since);
    return {
      level: s.level,
      quietHours: s.quietHours,
      lessLike: s.lessLike.map(({ topic, example }) => ({ topic, example })),
      cards: recent
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 60)
        .map(({ key, status, title, source }) => ({ key, status, title, source })),
      // Done means done. Other cards closed by "Do it" (they have a chat) were only handed to
      // Hermes; a reminder closes only with Done ("Do it" leaves it up).
      done: recent.filter((c) => c.status === 'done' && (c.kind === 'reminder' || !c.chat)).map((c) => c.key),
    };
  }

  // ---- The pulse's side -------------------------------------------------------------

  ingest(source: FeedSource, cards: CardInput[]): { created: number; updated: number } {
    return (this.deps.background ?? shadowBackground).run(() => this.ingestCards(source, cards)) ?? { created: 0, updated: 0 };
  }

  private ingestCards(source: FeedSource, cards: CardInput[]): { created: number; updated: number } {
    const { created, updated, removed } = this.deps.store.ingest(source, cards);
    for (const card of [...created, ...updated]) this.publish(card);
    for (const id of removed) this.deps.hub.publish({ type: 'feed_removed', id });
    const s = this.deps.store.settings();
    if (created.length && s.push.cards && s.level !== 'off') {
      const first = created[0]!;
      this.notify({
        title: 'For you',
        body: created.length === 1 ? first.title : `${created.length} new · ${first.title}`,
        url: '/#for-you',
        tag: 'for-you',
        ttl: 12 * 3600,
        urgency: 'normal',
        topic: 'foryou',
      });
    }
    return { created: created.length, updated: updated.length };
  }

  /**
   * Signalbox's own side: close an open card whose subject is over (the task log
   * closes "task:<worker id>" when an overdue worker stops running). The browser
   * drops it on the update. A closed card has no chat, so it counts as done in
   * preferences(); harmless, since the pulse only ticks off its own "loop:" keys.
   */
  close(key: string): void {
    const card = this.deps.store.close(key);
    if (card) this.publish(card);
  }

  // ---- Your side ------------------------------------------------------------------

  markSeen(): void {
    for (const card of this.deps.store.markSeen()) this.publish(card);
  }

  async act(id: string, action: FeedAction): Promise<FeedActionResult> {
    const { store } = this.deps;
    const card = store.get(id);
    if (!card) throw new UserFacingError('That card is gone.', 404);
    let updated: FeedCard | undefined;
    switch (action) {
      case 'do': {
        if (!card.action) throw new UserFacingError('This card has nothing to do.', 400);
        if (card.chat) return { card, chat: card.chat };
        const { id: chatId } = await this.deps.hermes.createConversation(this.doPrompt(card));
        const chat = { source: 'hermes' as const, id: chatId };
        // A reminder stays up (with its chat) until you tap Done; anything else is handed over.
        updated = store.setStatus(id, card.kind === 'reminder' ? 'seen' : 'done', { chat });
        this.publish(updated!);
        return { card: updated!, chat };
      }
      case 'later':
        updated = store.setStatus(id, 'later', { laterUntil: this.laterUntil() });
        break;
      case 'less':
        if (card.topic) store.addLessLike(card.topic, card.title);
        updated = store.setStatus(id, 'dismissed');
        break;
      case 'done':
        updated = store.setStatus(id, 'done');
        break;
      case 'dismiss':
        updated = store.setStatus(id, 'dismissed');
        break;
    }
    this.publish(updated!);
    return { card: updated! };
  }

  async updateSettings(patch: {
    level?: ProactivityLevel;
    quietHours?: { start: string; end: string } | null;
    push?: Partial<StoredSettings['push']>;
    removeLessLike?: string;
  }): Promise<FeedSettings> {
    const { store } = this.deps;
    if (patch.level && patch.level !== store.settings().level) await this.applyLevel(patch.level);
    const next: Partial<StoredSettings> = {};
    if (patch.level) next.level = patch.level;
    if (patch.quietHours !== undefined) next.quietHours = patch.quietHours;
    if (patch.push) next.push = { ...store.settings().push, ...patch.push };
    if (Object.keys(next).length) store.updateSettings(next);
    if (patch.removeLessLike) store.removeLessLike(patch.removeLessLike);
    return this.settings();
  }

  /** The key browsers subscribe with. */
  pushKey(): string {
    if (!this.deps.push) throw new UserFacingError('Phone notifications need Wayroost on https.', 409);
    return this.deps.push.publicKey();
  }

  bindDevices(devices: Devices | undefined): void {
    this.deps.push?.bindDevices(devices);
  }

  revokeDevice(deviceId: string): void {
    this.deps.push?.revokeDevice(deviceId);
  }

  addDevice(input: PushSubscriptionInput, deviceId: string): number {
    if (!this.deps.push) throw new UserFacingError('Phone notifications need Wayroost on https.', 409);
    try {
      return this.deps.push.add(input, deviceId, this.now());
    } catch (err) {
      if (err instanceof RangeError) {
        throw new UserFacingError(`That browser can't get notifications here (${err.message}).`, 400);
      }
      this.deps.log.warn({ err: (err as Error).name }, 'could not save a device for notifications');
      throw new UserFacingError("Wayroost couldn't save this device. Try again.", 500);
    }
  }

  removeDevice(endpoint: string, deviceId: string): number {
    return this.deps.push?.remove(endpoint, deviceId) ?? 0;
  }

  async testPush(): Promise<{ sent: number }> {
    if (!this.deps.push) throw new UserFacingError('Phone notifications need Wayroost on https.', 409);
    if (!this.deps.push.devices()) throw new UserFacingError('No phone or browser is set up for notifications yet.', 409);
    const result = await this.deps.push.send(
      { title: 'Wayroost', body: 'Notifications work.', url: '/#for-you', tag: 'test', ttl: 300, urgency: 'normal' },
      this.now(),
      true,
    );
    if (!result.sent) throw new UserFacingError("The push service didn't take the test notification.", 502);
    return { sent: result.sent };
  }

  // ---- Inside -------------------------------------------------------------------------

  private publish(card: FeedCard): void {
    this.deps.hub.publish({ type: 'feed_upsert', card });
  }

  private wake(): void {
    for (const card of this.deps.store.wakeLater()) this.publish(card);
    for (const id of this.deps.store.prune()) this.deps.hub.publish({ type: 'feed_removed', id });
  }

  private observe(event: ServerEvent): void {
    (this.deps.background ?? shadowBackground).run(() => {
      if (event.type === 'approval_upsert') this.notifyApproval(event.approval);
    });
  }

  /**
   * An agent is waiting on you: say so on the phone, without the command itself.
   * Quiet hours don't apply: this is work you started (it has its own switch).
   */
  private notifyApproval(approval: Approval): void {
    const s = this.deps.store.settings();
    if (!this.deps.push || !s.push.approvals || !this.deps.push.devices()) return;
    if (!this.deps.store.markNotified(`${approval.source}:${approval.conversationId}:${approval.id}`)) return;
    this.notify(
      {
        title: `${SOURCE_NAMES[approval.source]} needs you`,
        body: oneLine(approval.title, 80) || 'Open Wayroost to answer.',
        url: `/c/${approval.source}/${encodeURIComponent(approval.conversationId)}`,
        tag: `approval-${approval.source}-${approval.conversationId}`.slice(0, 64),
        ttl: 3600,
        urgency: 'high',
        topic: 'approvals',
      },
      { evenWhenQuiet: true },
    );
  }

  private notify(message: PushMessage, { evenWhenQuiet = false } = {}): void {
    const { push } = this.deps;
    if (!push || !push.devices() || (!evenWhenQuiet && this.quiet(this.now()))) return;
    (this.deps.background ?? shadowBackground).run(() => push.send(message, this.now()).catch((err: Error) => this.deps.log.warn({ err: err.message }, 'notification not sent')));
  }

  /** Local "HH:MM". */
  private clock(at: number): string {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
    }).format(at);
  }

  quiet(at: number): boolean {
    const hours = this.deps.store.settings().quietHours;
    if (!hours || hours.start === hours.end) return false;
    const t = this.clock(at);
    return hours.start < hours.end ? t >= hours.start && t < hours.end : t >= hours.start || t < hours.end;
  }

  /** "Not now": three hours from now, or the end of quiet hours if that falls inside them. */
  laterUntil(): number {
    const now = this.now();
    let until = now + LATER_MS;
    // Step forward through quiet hours a quarter-hour at a time (at most a day).
    for (let i = 0; i < 96 && this.quiet(until); i++) until += 15 * 60_000;
    return until;
  }

  private doPrompt(card: FeedCard): string {
    const when = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(this.deps.timeZone ? { timeZone: this.deps.timeZone } : {}),
    }).format(card.createdAt);
    const lines = [`From my For-you feed (${SOURCE_LABELS[card.source]}, ${when}): "${card.title}"`];
    if (card.detail) lines.push(card.detail);
    lines.push('', `Please: ${card.action}`);
    const split = card.key.indexOf(':');
    const kind = card.key.slice(0, split);
    const ref = card.key.slice(split + 1);
    if (kind === 'mail') lines.push(`(The email's Gmail message id is ${ref}.)`);
    if (kind === 'event') lines.push(`(The calendar event id is ${ref}.)`);
    lines.push('Check with me before you send anything or change anything.');
    return lines.join('\n');
  }

  private async pulseJobs(): Promise<{ brief?: ScheduleJob; scout?: ScheduleJob }> {
    if (!this.deps.schedules) return {};
    const list: ScheduleList = await this.deps.schedules.list();
    const find = (name: string) => list.jobs.find((j) => j.source === 'hermes' && j.name === name);
    return { brief: find(BRIEF_JOB), scout: find(SCOUT_JOB) };
  }

  private async findPulse(): Promise<void> {
    this.lastLook = this.now();
    try {
      const { brief, scout } = await this.pulseJobs();
      this.pulseFound = Boolean(brief && scout);
    } catch {
      this.pulseFound = false;
    }
  }

  /** Pause, resume and reschedule the pulse jobs for a level. */
  private async applyLevel(level: ProactivityLevel): Promise<void> {
    const schedules = this.deps.schedules;
    if (!schedules) throw new UserFacingError("Wayroost can't reach Hermes' scheduled jobs here.", 409);
    let jobs: { brief?: ScheduleJob; scout?: ScheduleJob };
    try {
      jobs = await this.pulseJobs();
    } catch {
      throw new UserFacingError("Hermes didn't answer, so the level wasn't changed. Try again in a moment.", 503);
    }
    const { brief, scout } = jobs;
    this.pulseFound = Boolean(brief && scout);
    if (!brief || !scout) {
      throw new UserFacingError(`Hermes has no ${BRIEF_JOB} and ${SCOUT_JOB} jobs to adjust.`, 409);
    }
    const finished = [brief, scout].find((j) => j.state === 'done');
    if (finished) {
      throw new UserFacingError(`${finished.name} has finished in Hermes. Turn it back on in Settings → Scheduled jobs.`, 409);
    }
    const wantBrief = level !== 'off';
    const wantScout = level === 'normal' || level === 'high';
    // A job's state can read "running" while it is paused, so don't infer: say what each should be
    // (pausing a paused job, or resuming an active one, changes nothing).
    await schedules.setPaused('hermes', brief.id, !wantBrief);
    if (wantScout) {
      const schedule = SCOUT_SCHEDULES[level as 'normal' | 'high'];
      if (scout.scheduleInput !== schedule) await schedules.update('hermes', scout.id, { schedule });
    }
    await schedules.setPaused('hermes', scout.id, !wantScout);
    this.deps.log.info({ level }, 'proactivity level applied to the pulse jobs');
  }
}
