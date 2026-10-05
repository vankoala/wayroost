import type { AppNotification, Approval, ConversationStatus, DevicePresence, NotificationSettingsView, PresenceState, ServerEvent, SourceState } from '../../../shared/protocol.js';
import type { NotificationEvent, NotificationSource } from '../../../shared/settings.js';
import type { EventHub } from '../hub.js';
import type { PushMessage, PushSender, PushSubscriptionInput } from '../feed/push.js';
import type { Devices } from '../devices.js';
import { UserFacingError } from '../sources.js';
import { FeedStore, oneLine } from '../feed/store.js';
import { Feed, type FeedDeps } from '../feed/service.js';
import { shadowBackground, type BackgroundGate } from '../background.js';
import { decideNotification, desktopPresence, type NotificationDecision } from './routing.js';
import { NotificationSettingsStore, type ChangeContext, type NotificationSettings, type NotificationSettingsInput } from './settings.js';
import type { ConfigApplyRequest, ConfigReadRequest, ConfigReadResult, ConfigUndoRequest, ConfigWriteResult } from '../../../shared/supervisor-config.js';

// Wayroost's alerts: the rules, the PC's presence and quiet hours say where each one goes,
// and everything else asks this service. An alert the app should show leaves as a
// `notification` event on the stream the app already reads, so the desktop app, the phone's
// browser and every other page show what the owner allowed and nothing more. What goes to the
// phone goes over Web Push, through the sender the For-you feed set up.

/** Text written by an agent or read from a file is given one line, with links flattened out. */
const BODY_MAX = 120;
const TITLE_MAX = 80;
const DEFAULT_TTL_SECONDS = 3_600;

/** One alert, in the words its author meant for the notification. */
export interface NotificationAlert {
  event: NotificationEvent;
  source: NotificationSource;
  title: string;
  /** Plain text, one line; the page it points at holds the rest. */
  body?: string;
  /** A path on this Wayroost, opened when the alert is tapped. */
  url: string;
  /** Notifications with this tag replace each other on the phone. */
  tag: string;
  /** How long the push service may hold a push for an offline phone. */
  ttl?: number;
  /** Push-service side replacement of an undelivered push with the same topic. */
  topic?: string;
  /** An answer waiting on a person is worth waking the phone for. */
  urgent?: boolean;
  approval?: AppNotification['approval'];
}

/** What the For-you feed holds in these same settings: quiet hours and its card switch. */
export interface FeedRouting {
  applyRouting(routing: { quietHours: NotificationSettings['quietHours']; push: NotificationSettings['push'] }): void;
}

export interface NotificationsLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface NotificationsDeps {
  settings: NotificationSettingsStore;
  hub: EventHub;
  log: NotificationsLog;
  /** Phone pushes; absent when Wayroost isn't on https. */
  push?: PushSender;
  /** The For-you feed, whose page edits the same quiet hours and card switch. */
  feed?: FeedRouting;
  background?: BackgroundGate;
  now?: () => number;
  /** The owner's time zone, from the site file; quiet hours are read in it. */
  timeZone?: string;
  /** Persistent phone deduplication; app delivery never depends on this succeeding. */
  claimPush?: (key: string) => boolean;
}

export interface NotificationServicesDeps extends Omit<NotificationsDeps, 'settings' | 'feed' | 'claimPush'> {
  stateDir: string;
  feedEnabled: boolean;
  hermes: FeedDeps['hermes'];
  schedules?: FeedDeps['schedules'];
}

/** Migrate before synchronizing the feed, and share the owner's zone with both readers. */
export async function createNotificationServices(deps: NotificationServicesDeps): Promise<{ notifications: Notifications; feed?: Feed }> {
  const store = new FeedStore(deps.stateDir, deps.now);
  const settings = new NotificationSettingsStore(deps.stateDir);
  let migrated = true;
  try { await (deps.background ?? shadowBackground).run(() => settings.initialize(store.settings())); }
  catch { migrated = false; deps.log.warn({}, 'notification preferences could not be migrated; stored settings have been left intact'); }
  const feed = deps.feedEnabled ? new Feed({
    store, hub: deps.hub, hermes: deps.hermes, schedules: deps.schedules, push: deps.push,
    log: deps.log, background: deps.background, now: deps.now, timeZone: deps.timeZone,
  }) : undefined;
  const notifications = new Notifications({ ...deps, settings, feed, claimPush: (key) => store.markNotified(key) });
  if (feed) {
    feed.useRouting(notifications);
    if (migrated) {
      try { (deps.background ?? shadowBackground).run(() => feed.applyRouting(notifications.settings())); }
      catch { deps.log.warn({}, 'feed notification preferences could not be synchronized'); }
    }
  }
  return { notifications, ...(feed ? { feed } : {}) };
}

export class Notifications {
  private reports: (() => DevicePresence[]) | undefined;
  private readonly now: () => number;
  private readonly approvals = new Map<string, number>();
  private readonly conversations = new Map<string, ConversationStatus>();
  private readonly retiredConversations = new Set<string>();
  private readonly sources = new Map<string, SourceState>();
  private readonly mismatches = new Set<string>();

  constructor(private readonly deps: NotificationsDeps) {
    this.now = deps.now ?? Date.now;
    deps.hub.observe((event) => (deps.background ?? shadowBackground).run(() => this.observe(event)));
  }

  /**
   * The PC's presence reports, read from the power page's own record of them. Nothing is
   * watched here: whoever has an alert asks for it when it happens, and the report is read
   * then, so a desktop that stopped reporting counts as gone from then on.
   */
  bindPresence(reports: () => DevicePresence[]): void {
    this.reports = reports;
  }

  bindDevices(devices: Devices | undefined): void {
    this.deps.push?.bindDevices(devices);
  }

  revokeDevice(id: string): void {
    this.deps.push?.revokeDevice(id);
  }

  private pushSender(): PushSender {
    if (!this.deps.push) throw new UserFacingError('Phone notifications need Wayroost on https.', 409);
    return this.deps.push;
  }

  pushKey(): string {
    return this.pushSender().publicKey();
  }

  addDevice(input: PushSubscriptionInput, deviceId: string): number {
    const push = this.pushSender();
    try { return push.add(input, deviceId, this.now()); }
    catch (err) {
      if (err instanceof RangeError) throw new UserFacingError(`That browser can't get notifications here (${err.message}).`, 400);
      this.deps.log.warn({}, 'could not save a device for notifications');
      throw new UserFacingError("Wayroost couldn't save this device. Try again.", 500);
    }
  }

  removeDevice(endpoint: string, deviceId: string): number {
    return this.deps.push?.remove(endpoint, deviceId) ?? 0;
  }

  async testPush(): Promise<{ sent: number }> {
    const push = this.pushSender();
    if (!push.devices()) throw new UserFacingError('No phone or browser is set up for notifications yet.', 409);
    const result = await push.send({ title: 'Wayroost', body: 'Notifications work.', url: '/#settings', tag: 'test', ttl: 300, urgency: 'normal' }, this.now(), true);
    if (!result.sent) throw new UserFacingError("The push service didn't take the test notification.", 502);
    return { sent: result.sent };
  }

  settings(): NotificationSettingsView {
    const stored = this.deps.settings.settings();
    return {
      rules: stored.rules,
      quietHours: stored.quietHours,
      push: stored.push,
      pushAvailable: Boolean(this.deps.push),
      pushDevices: this.deps.push?.devices() ?? 0,
      presence: this.currentPresence(),
      timeZoneConfigured: this.deps.timeZone !== undefined,
    };
  }

  async configRead(_request: ConfigReadRequest): Promise<ConfigReadResult> {
    return this.deps.settings.configRead();
  }

  /** The settings pipeline owns authorization, audit and events; this service owns persistence and routing. */
  async configApply(request: ConfigApplyRequest): Promise<ConfigWriteResult> {
    const result = await this.deps.settings.configApply(request);
    if (result.ok || 'committed' in result) this.syncFeed(this.deps.settings.settings());
    return result;
  }

  async configUndo(request: ConfigUndoRequest): Promise<ConfigWriteResult> {
    const result = await this.deps.settings.configUndo(request);
    if (result.ok || 'committed' in result) this.syncFeed(this.deps.settings.settings());
    return result;
  }

  /** Change the rules, the quiet hours or the phone's switches, and tell the pages to read them again. */
  async update(input: NotificationSettingsInput, context: ChangeContext = {}): Promise<NotificationSettingsView> {
    const change = await this.deps.settings.change(input, context);
    if (change.changed && (input.quietHours !== undefined || input.push !== undefined)) {
      this.syncFeed(change.settings);
    }
    this.deps.hub.publish({ type: 'settings_changed', sections: ['notifications'] });
    return this.settings();
  }

  /**
   * Quiet hours and the card switch as the For-you page writes them: the same settings,
   * reached through another door, so it isn't told to read them again by its own save.
   */
  async setRouting(routing: Pick<NotificationSettingsInput, 'quietHours' | 'push'>): Promise<NotificationSettings> {
    const change = await this.deps.settings.change(routing);
    this.deps.hub.publish({ type: 'settings_changed', sections: ['notifications'] });
    return change.settings;
  }

  /** Where one alert would go right now, as the settings page describes it. */
  decide(event: NotificationEvent, source: NotificationSource): NotificationDecision {
    return decideNotification(event, source, this.deps.settings.settings(), this.currentPresence(), this.now(), this.deps.timeZone);
  }

  /** Show an alert where the rules, the presence and the clock allow, and say where it went. */
  alert(alert: NotificationAlert, claimPush?: () => boolean): NotificationDecision {
    const decision = this.decide(alert.event, alert.source);
    const body = alert.body === undefined ? undefined : oneLine(alert.body, BODY_MAX);
    const title = oneLine(alert.title, TITLE_MAX);
    if (decision.toast) this.publishToast(alert, title, body);
    if (decision.push && this.deps.push?.devices()) {
      try {
        if (!claimPush || claimPush()) this.sendPush(alert, title, body);
      } catch {
        this.deps.log.warn({}, 'notification phone deduplication could not be saved');
      }
    }
    this.deps.log.info(
      { event: alert.event, source: alert.source, toast: decision.toast, push: decision.push, presence: decision.presence },
      'notification routed',
    );
    return decision;
  }

  /** An agent needs an answer: the one alert that is never switched off. */
  needsYou(approval: Approval): void {
    const alert = this.approvalAlert(approval);
    this.alert(alert, this.deps.claimPush ? () => this.deps.claimPush!(`${approval.source}:${approval.conversationId}:${approval.id}:${approval.createdAt}`) : undefined);
  }

  /** Current routes for pending requests, without sending pushes or recording delivery. */
  approvalNotifications(approvals: readonly Approval[]): AppNotification[] {
    return approvals.filter((approval) => this.decide('agent-needs-you', approval.source).toast)
      .map((approval) => {
        const alert = this.approvalAlert(approval);
        return this.appNotification(alert, oneLine(alert.title, TITLE_MAX), oneLine(alert.body!, BODY_MAX));
      });
  }

  private approvalAlert(approval: Approval): NotificationAlert {
    return {
      event: 'agent-needs-you',
      source: approval.source,
      title: `${approval.source === 'hermes' ? 'Hermes' : 'Paseo'} needs you`,
      body: approval.title,
      url: `/c/${approval.source}/${encodeURIComponent(approval.conversationId)}`,
      tag: `approval-${approval.source}-${approval.conversationId}`.slice(0, 64),
      ttl: 3_600,
      topic: 'approvals',
      urgent: true,
      approval: { id: approval.id, source: approval.source, conversationId: approval.conversationId, createdAt: approval.createdAt },
    };
  }

  currentPresence(): PresenceState | 'gone' {
    return desktopPresence(this.reports?.() ?? [], this.now());
  }

  /** Repeated checks of the same unresolved mismatch produce one alert. */
  mismatch(source: NotificationSource, found: boolean, identity: string = source): void {
    if (!found) { this.mismatches.delete(identity); return; }
    if (this.mismatches.has(identity)) return;
    this.mismatches.add(identity);
    this.alert({ event: 'mismatch-warning', source, title: 'Saved settings need application', url: '/#settings', tag: `mismatch-${source}` });
  }

  // ---- Inside -------------------------------------------------------------------

  private syncFeed(settings: NotificationSettings): void {
    try { this.deps.feed?.applyRouting(settings); }
    catch { this.deps.log.warn({}, 'notification settings saved; feed reads the authoritative preferences'); }
  }

  private observe(event: ServerEvent): void {
    if (event.type === 'approval_upsert') {
      const approval = event.approval;
      const key = `${approval.source}/${approval.conversationId}/${approval.id}`;
      if (this.approvals.get(key) === approval.createdAt) return;
      this.approvals.set(key, approval.createdAt);
      this.needsYou(approval);
    } else if (event.type === 'approval_removed') {
      this.approvals.delete(`${event.source}/${event.conversationId}/${event.approvalId}`);
    } else if (event.type === 'conversation_upsert') {
      const conversation = event.conversation;
      const key = `${conversation.source}/${conversation.id}`;
      if (this.retiredConversations.has(key)) return;
      const previous = this.conversations.get(key);
      this.conversations.set(key, conversation.status);
      const finished = event.turnOutcome === 'complete';
      const failed = event.turnOutcome === 'error' || (conversation.source !== 'paseo'
        && event.turnOutcome === undefined && conversation.status === 'error' && previous !== 'error');
      if (finished || failed) this.alert({
        event: failed ? 'agent-error' : 'agent-finished', source: conversation.source,
        title: failed ? 'An agent failed' : 'An agent finished', body: conversation.title,
        url: `/c/${conversation.source}/${encodeURIComponent(conversation.id)}`, tag: `run-${key}`,
      });
    } else if (event.type === 'conversation_moved') {
      const from = `${event.source}/${event.from}`;
      const to = `${event.source}/${event.to}`;
      const status = this.conversations.get(from);
      if (status !== undefined) this.conversations.set(to, status);
      this.conversations.delete(from);
      this.retiredConversations.add(from);
    } else if (event.type === 'conversation_removed') {
      this.conversations.delete(`${event.source}/${event.id}`);
    } else if (event.type === 'source_status') {
      const { source, state } = event.status;
      const previous = this.sources.get(source);
      this.sources.set(source, state);
      if (previous !== undefined && previous !== state && state !== 'connecting') this.alert({
        event: 'stack-status', source, title: state === 'connected' ? 'A service is answering again' : 'A service needs attention',
        url: '/#status', tag: `service-${source}`,
      });
    }
  }

  private appNotification(alert: NotificationAlert, title: string, body: string | undefined): AppNotification {
    return {
      event: alert.event, source: alert.source, title, ...(body ? { body } : {}),
      url: alert.url, at: this.now(), ...(alert.approval ? { approval: alert.approval } : {}),
    };
  }

  private publishToast(alert: NotificationAlert, title: string, body: string | undefined): void {
    this.deps.hub.publish({
      type: 'notification',
      notification: this.appNotification(alert, title, body),
    });
  }

  private sendPush(alert: NotificationAlert, title: string, body: string | undefined): void {
    const { push } = this.deps;
    if (!push || !push.devices()) return;
    const message: PushMessage = {
      title,
      body: body ?? '',
      url: alert.url,
      tag: alert.tag.slice(0, 64),
      ttl: alert.ttl ?? DEFAULT_TTL_SECONDS,
      urgency: alert.urgent ? 'high' : 'normal',
      ...(alert.topic ? { topic: alert.topic } : {}),
    };
    (this.deps.background ?? shadowBackground).run(() =>
      push.send(message, this.now()).catch((err: Error) => this.deps.log.warn({ err: err.message }, 'notification not sent')),
    );
  }
}
