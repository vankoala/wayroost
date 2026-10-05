import { z } from 'zod';
import { settingsNotificationsBodySchema, type SettingsNotificationsBody } from '../../../shared/settings.js';

/** A snapshot of the supervisor's persisted settings, shared by the live consumers. */
export class WayroostSettingsStore {
  private available = false;
  private safety = false;
  private notifications = settingsNotificationsBodySchema.parse({
    push: { approvals: true, cards: false }, quietHours: { start: '21:00', end: '07:00' },
  });

  update(document: Record<string, unknown>): void {
    const safety = z.boolean().parse(document.safetyCommandsEnabled ?? false);
    const notifications = settingsNotificationsBodySchema.parse({
      push: { approvals: true, cards: false, ...settingsNotificationsBodySchema.shape.push.partial().parse(document.push ?? {}) },
      quietHours: Object.hasOwn(document, 'quietHours') ? document.quietHours : { start: '21:00', end: '07:00' },
      ...(Object.hasOwn(document, 'rules') ? { rules: document.rules } : {}),
    });
    this.safety = safety;
    this.notifications = notifications;
    this.available = true;
  }

  invalidate(): void { this.available = false; }
  safetyCommandsEnabled(): boolean { return this.available && this.safety; }
  notificationSettings(): SettingsNotificationsBody {
    return structuredClone(this.notifications);
  }
}
