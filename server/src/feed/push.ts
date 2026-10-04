import { checkDeviceSignal, actionSignal } from '../security/device-signal.js';
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { shadowBackground, type BackgroundGate } from '../background.js';
import type { Devices } from '../devices.js';

// Phone notifications (Web Push). Signalbox signs each request to the browser's
// push service with its own key (VAPID, RFC 8292) and encrypts the message so
// only that browser can read it (RFC 8291, aes128gcm); the push service sees
// neither the text nor the link. No library: Node's crypto does both. The key
// and the devices that asked for notifications live in the state directory.

const FILE = 'push.json';
const MAX_DEVICES = 10;
const SEND_TIMEOUT_MS = 10_000;
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3000;

/**
 * The push services browsers use (Chrome/Android, Firefox, Safari/iOS, Edge).
 * Signalbox only ever posts to these, so a subscription can't aim it elsewhere.
 */
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export const PushSubscriptionInput = z.object({
  endpoint: z.string().max(2000),
  keys: z.object({
    p256dh: z.string().min(80).max(100).regex(B64URL),
    auth: z.string().min(16).max(32).regex(B64URL),
  }),
  label: z.string().trim().max(60).optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export interface PushMessage {
  title: string;
  body: string;
  /** Opened when the notification is tapped (a path on this Signalbox). */
  url: string;
  /** Notifications with the same tag replace each other on the phone. */
  tag: string;
  /** How long the push service may hold it for an offline phone. */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** Push-service side replacement of an undelivered message with the same topic. */
  topic?: string;
}

interface Device {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string;
  createdAt: number;
}

interface PushFile {
  vapid: { kty: string; crv: string; d: string; x: string; y: string };
  devices: Device[];
}

export interface PushLog {
  warn(obj: object, msg: string): void;
}

/** Why an endpoint is refused, or null if it's a known push service over https. */
export function endpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'credentials in the URL';
  if (url.port && url.port !== '443') return 'unexpected port';
  if (!PUSH_HOSTS.some((host) => host.test(url.hostname.toLowerCase()))) return 'not a known push service';
  return null;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
/** "label" followed by a zero byte, as RFC 8291 spells its info strings. */
const info = (label: string) => Buffer.concat([Buffer.from(label, 'utf8'), Buffer.from([0])]);

/**
 * Encrypt one message for one browser (RFC 8291, a single aes128gcm record).
 * `salt` and `serverPrivateKey` are for tests only; normally both are fresh.
 */
export function encryptPayload(
  payload: Buffer,
  browserPublicKey: Buffer,
  authSecret: Buffer,
  options: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
  const ecdh = createECDH('prime256v1');
  if (options.serverPrivateKey) ecdh.setPrivateKey(options.serverPrivateKey);
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserPublicKey);
  const salt = options.salt ?? randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([info('WebPush: info'), browserPublicKey, serverPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, sealed]);
}

export class PushSender {
  private readonly path: string;
  private file: PushFile;
  private readonly key: KeyObject;
  private persisted = false;
  private paired: Pick<Devices, 'get' | 'signal'> | undefined;

  constructor(
    stateDir: string,
    /** The VAPID contact: this Signalbox's https address (never a personal email). */
    private readonly subject: string,
    private readonly log: PushLog,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly background: BackgroundGate = shadowBackground,
  ) {
    this.path = join(stateDir, FILE);
    [this.file, this.key] = this.load();
  }

  private load(): [PushFile, KeyObject] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PushFile>;
      if (raw.vapid?.d && raw.vapid.x && raw.vapid.y) {
        const vapid = { kty: 'EC', crv: 'P-256', d: raw.vapid.d, x: raw.vapid.x, y: raw.vapid.y };
        const key = createPrivateKey({ key: vapid, format: 'jwk' });
        this.persisted = true;
        const stored = Array.isArray(raw.devices) ? raw.devices : [];
        // Older subscriptions have no pairing to authorize them; browsers subscribe again.
        const devices = stored.filter((device) => typeof device?.deviceId === 'string' && /^dv_[a-f0-9]{24}$/.test(device.deviceId));
        const file = { vapid, devices };
        if (devices.length !== stored.length) this.background.run(() => {
          try { this.write(file); }
          catch (err) { this.log.warn({ err: (err as Error).name }, 'could not remove unpaired push subscriptions'); }
        });
        return [file, key];
      }
    } catch (err) {
      // First start, or an unusable file: a new key (phones subscribe again) beats not starting.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn({ err: (err as Error).name }, 'push.json unusable: made a new notifications key');
      }
    }
    // Keep what was there (push.json.bad) rather than writing over the only copy.
    this.background.run(() => {
      if (existsSync(this.path)) {
        try {
          renameSync(this.path, `${this.path}.bad`);
        } catch {
          // can't move it: the new file replaces it
        }
      }
    });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' }) as PushFile['vapid'];
    const file: PushFile = { vapid: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, devices: [] };
    this.background.run(() => this.write(file));
    return [file, privateKey];
  }

  private write(file: PushFile): void {
    checkDeviceSignal();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.persisted = true;
  }

  /** The public key browsers subscribe with (uncompressed P-256 point, base64url). */
  publicKey(): string {
    if (!this.persisted) this.write(this.file);
    const x = Buffer.from(this.file.vapid.x, 'base64url');
    const y = Buffer.from(this.file.vapid.y, 'base64url');
    return Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');
  }

  bindDevices(devices: Pick<Devices, 'get' | 'signal'> | undefined): void {
    this.paired = devices;
  }

  devices(): number {
    return this.file.devices.filter((device) => this.paired?.get(device.deviceId)).length;
  }

  /** Remember a browser's subscription (replacing one with the same endpoint). Returns the device count. */
  add(input: PushSubscriptionInput, deviceId: string, now = Date.now()): number {
    checkDeviceSignal();
    if (!this.paired?.get(deviceId)) throw new RangeError('device is no longer paired');
    const problem = endpointProblem(input.endpoint);
    if (problem) throw new RangeError(problem);
    const p256dh = Buffer.from(input.keys.p256dh, 'base64url');
    const auth = Buffer.from(input.keys.auth, 'base64url');
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new RangeError('malformed keys');
    const device: Device = {
      deviceId,
      endpoint: input.endpoint,
      p256dh: p256dh.toString('base64url'),
      auth: auth.toString('base64url'),
      ...(input.label ? { label: input.label } : {}),
      createdAt: now,
    };
    const others = this.file.devices.filter((d) => d.endpoint !== input.endpoint);
    this.file = { ...this.file, devices: [...others, device].slice(-MAX_DEVICES) };
    this.write(this.file);
    return this.file.devices.length;
  }

  remove(endpoint: string, deviceId?: string): number {
    checkDeviceSignal();
    const devices = this.file.devices.filter((d) => d.endpoint !== endpoint || (deviceId !== undefined && d.deviceId !== deviceId));
    if (devices.length !== this.file.devices.length) {
      this.file = { ...this.file, devices };
      this.write(this.file);
    }
    return devices.length;
  }

  revokeDevice(deviceId: string): void {
    const devices = this.file.devices.filter((device) => device.deviceId !== deviceId);
    if (devices.length === this.file.devices.length) return;
    this.file = { ...this.file, devices };
    this.write(this.file);
  }

  private authorization(endpoint: string, now: number): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: this.subject };
    const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode(claims)}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: this.key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${this.publicKey()}`;
  }

  /** Send to every device. Ones the push service says are gone (404/410) are forgotten. */
  async send(message: PushMessage, now = Date.now(), requested = false): Promise<{ sent: number; failed: number; removed: number }> {
    if (!requested && !this.background.run(() => true)) return { sent: 0, failed: 0, removed: 0 };
    const payload = Buffer.from(
      JSON.stringify({ title: message.title, body: message.body, url: message.url, tag: message.tag }),
      'utf8',
    );
    if (payload.length > MAX_PAYLOAD) throw new RangeError('notification too large');
    let sent = 0;
    let failed = 0;
    const gone: Device[] = [];
    await Promise.all(
      this.file.devices.map(async (device) => {
        if (!this.paired?.get(device.deviceId) || endpointProblem(device.endpoint)) {
          gone.push(device);
          return;
        }
        const recipient = this.paired.signal(device.deviceId);
        try {
          const body = encryptPayload(
            payload,
            Buffer.from(device.p256dh, 'base64url'),
            Buffer.from(device.auth, 'base64url'),
          );
          checkDeviceSignal();
          const res = await this.fetchImpl(device.endpoint, {
            method: 'POST',
            headers: {
              ttl: String(message.ttl),
              urgency: message.urgency,
              ...(message.topic ? { topic: message.topic } : {}),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              authorization: this.authorization(device.endpoint, now),
            },
            body,
            redirect: 'error',
            signal: actionSignal(actionSignal(AbortSignal.timeout(SEND_TIMEOUT_MS), recipient)),
          });
          // Nothing to read in the answer: let the connection go.
          await res.body?.cancel().catch(() => {});
          checkDeviceSignal(recipient);
          if (res.status === 404 || res.status === 410) gone.push(device);
          else if (res.ok) sent += 1;
          else {
            failed += 1;
            this.log.warn({ status: res.status, host: new URL(device.endpoint).hostname }, 'push service refused a notification');
          }
        } catch (err) {
          failed += 1;
          this.log.warn({ err: (err as Error).name, host: new URL(device.endpoint).hostname }, 'could not reach a push service');
        }
      }),
    );
    let removed = 0;
    for (const device of gone) {
      // Registration can replace this record while another send is pending.
      if (!this.file.devices.includes(device)) continue;
      this.remove(device.endpoint);
      removed += 1;
    }
    return { sent, failed, removed };
  }
}
