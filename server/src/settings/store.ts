import { settingsNotificationsBodySchema, type SettingsNotificationsBody } from '../../../shared/settings.js';
import { wayroostSettingsSchema, type WayroostSettingsDocument } from '../../../shared/wayroost-settings.js';

/** A snapshot of the supervisor's persisted settings, shared by the live consumers. */
export class WayroostSettingsStore {
  private document?: WayroostSettingsDocument;
  private readonly observers = new Set<() => void>();

  update(document: Record<string, unknown>): void {
    const parsed = wayroostSettingsSchema.parse(document);
    if (JSON.stringify(this.document) === JSON.stringify(parsed)) return;
    this.document = parsed;
    this.changed();
  }

  invalidate(): void { this.document = undefined; }
  available(): boolean { return this.document !== undefined; }
  watch(observer: () => void): void { this.observers.add(observer); }
  private changed(): void { for (const observer of this.observers) observer(); }
  safetyCommandsEnabled(): boolean { return this.document?.safetyCommandsEnabled === true; }
  notificationSettings(): SettingsNotificationsBody {
    const document = this.document;
    return settingsNotificationsBodySchema.parse({
      push: { approvals: document !== undefined, cards: false, ...document?.push },
      quietHours: document && Object.hasOwn(document, 'quietHours') ? document.quietHours : { start: '21:00', end: '07:00' },
      ...(document?.rules ? { rules: document.rules } : {}),
    });
  }
  timeZone(): string | undefined { return this.document?.timeZone; }
  workerUpdates() {
    const enabled = this.document?.workerUpdates?.enabled;
    return { enabled: enabled === true, state: enabled === true ? 'verified-on' as const : enabled === false ? 'verified-off' as const : 'unknown' as const,
      defaultMinutes: this.document?.workerUpdates?.defaultMinutes ?? 60 };
  }
  voice() { return { voice: this.document?.voice?.voice ?? '', appReadAloud: this.document?.voice?.appReadAloud ?? { provider: 'local' as const } }; }
  feed() { return structuredClone({ level: this.document?.feed?.level ?? 'off', lessLike: this.document?.feed?.lessLike ?? [] }); }
}
