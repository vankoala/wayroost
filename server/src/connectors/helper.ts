import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhoneStatus, WhatsAppRouting } from '../../../shared/protocol.js';
import type { SkillList, SkillScan } from '../../../shared/skills.js';
import type { SkillsHelperApi } from '../skills.js';
import { UserFacingError } from '../sources.js';

// Talks to the Signalbox helper (helper/signalbox-helper.py) on 127.0.0.1:
// Google sign-in, trigger folders and the WhatsApp routing settings, which
// Signalbox's sandbox can't reach.

const TIMEOUT_MS = 90_000;

export interface HelperStatus {
  state: 'connected' | 'off' | 'needs-sign-in' | 'not-connected' | 'unknown';
  detail?: string;
}

export interface HelperApi {
  health(): Promise<boolean>;
  google(): Promise<HelperStatus>;
  googleStart(): Promise<{ url: string }>;
  googleFinish(redirect: string): Promise<HelperStatus>;
  googleDisconnect(): Promise<HelperStatus>;
  shops(): Promise<HelperStatus>;
  triggerQueries(): Promise<Record<string, string>>;
  putTrigger(id: string, query: string): Promise<{ workdir: string; script: string }>;
  deleteTrigger(id: string): Promise<void>;
  whatsappRouting(): Promise<WhatsAppRouting>;
  setWhatsappRouting(settings: Omit<WhatsAppRouting, 'installed' | 'active'>): Promise<WhatsAppRouting>;
  phone(): Promise<PhoneStatus>;
  phonePin(): Promise<{ pin: string | null }>;
  setPhonePin(pin: string): Promise<PhoneStatus>;
  setPhoneVoice(voice: string): Promise<{ voice: string | null }>;
}

/** The helper's shared secret, which systemd hands Signalbox (LoadCredential=helper-token:...). */
export function readHelperToken(): string | undefined {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    const token = readFileSync(join(dir, 'helper-token'), 'utf8').trim();
    return token.length >= 32 ? token : undefined;
  } catch {
    return undefined;
  }
}

export class HelperClient implements HelperApi, SkillsHelperApi {
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UserFacingError("The Signalbox helper isn't running on the PC.", 503);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok) {
      // The helper's errors are written for people and never carry secrets.
      const message = typeof data.error === 'string' ? data.error : `The Signalbox helper failed (${res.status}).`;
      throw new UserFacingError(message, res.status >= 500 ? 502 : res.status);
    }
    return data as T;
  }

  async health(): Promise<boolean> {
    try {
      await this.call('GET', '/health', undefined, 3_000);
      return true;
    } catch {
      return false;
    }
  }

  google() {
    return this.call<HelperStatus>('GET', '/google');
  }

  googleStart() {
    return this.call<{ url: string }>('POST', '/google/start', {});
  }

  googleFinish(redirect: string) {
    return this.call<HelperStatus>('POST', '/google/finish', { redirect });
  }

  googleDisconnect() {
    return this.call<HelperStatus>('POST', '/google/disconnect', {});
  }

  shops() {
    return this.call<HelperStatus>('GET', '/shops', undefined, 10_000);
  }

  async triggerQueries(): Promise<Record<string, string>> {
    const data = await this.call<{ triggers?: Record<string, { query?: unknown }> }>('GET', '/triggers');
    const out: Record<string, string> = {};
    for (const [id, spec] of Object.entries(data.triggers ?? {})) {
      if (typeof spec.query === 'string') out[id] = spec.query;
    }
    return out;
  }

  putTrigger(id: string, query: string) {
    return this.call<{ workdir: string; script: string }>('PUT', `/triggers/${encodeURIComponent(id)}`, { query });
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.call('DELETE', `/triggers/${encodeURIComponent(id)}`);
  }

  whatsappRouting() {
    return this.call<WhatsAppRouting>('GET', '/whatsapp-routing', undefined, 10_000);
  }

  setWhatsappRouting(settings: Omit<WhatsAppRouting, 'installed' | 'active'>) {
    return this.call<WhatsAppRouting>('PUT', '/whatsapp-routing', settings, 10_000);
  }

  phone() {
    return this.call<PhoneStatus>('GET', '/phone', undefined, 30_000);
  }

  phonePin() {
    return this.call<{ pin: string | null }>('GET', '/phone/pin', undefined, 30_000);
  }

  setPhonePin(pin: string) {
    return this.call<PhoneStatus>('PUT', '/phone/pin', { pin }, 30_000);
  }

  setPhoneVoice(voice: string) {
    return this.call<{ voice: string | null }>('PUT', '/phone/voice', { voice }, 40_000);
  }

  // ---- Settings → Skills ----

  skills() {
    return this.call<Omit<SkillList, 'installs'>>('GET', '/skills', undefined, 60_000);
  }

  async skillsVersion(): Promise<number> {
    return (await this.call<{ version: number }>('GET', '/skills/version', undefined, 5_000)).version;
  }

  skillContent(place: string, name: string) {
    const q = new URLSearchParams({ place, name });
    return this.call<{ name: string; place: string; text: string; truncated: boolean }>('GET', `/skills/content?${q}`, undefined, 10_000);
  }

  skillScan(place: string, name: string) {
    return this.call<SkillScan>('POST', '/skills/scan', { place, name }, 150_000);
  }

  skillShare(place: string, name: string, confirmCaution: boolean) {
    return this.call<{ shared: boolean; scan: SkillScan }>('POST', '/skills/share', { place, name, confirmCaution }, 150_000);
  }

  async skillTakeShared(place: string, name: string): Promise<void> {
    await this.call('POST', '/skills/take-shared', { place, name }, 60_000);
  }

  async skillExcluded(name: string, place: string, excluded: boolean): Promise<void> {
    await this.call('PUT', '/skills/excluded', { name, place, excluded }, 60_000);
  }

  async skillRemove(name: string): Promise<void> {
    await this.call('POST', '/skills/remove', { name }, 60_000);
  }

  async skillsRefresh(): Promise<void> {
    await this.call('POST', '/skills/refresh', {}, 60_000);
  }
}
