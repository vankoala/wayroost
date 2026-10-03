import { checkDeviceSignal } from './security/device-signal.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEVICE_KINDS, type DeviceInfo, type DeviceKind, type DeviceScope } from '../../shared/protocol.js';
import { UserFacingError } from './sources.js';
import { CODE_RE, normalizePairingCode } from '../../shared/pairing-code.js';
export { normalizePairingCode } from '../../shared/pairing-code.js';

// Device sign-in. Every browser, phone and the desktop app signs in as a paired
// device: the cookie `wr_device=<id>.<secret>` carries a 256-bit secret of which
// only the SHA-256 hash is kept, in <stateDir>/devices.json (mode 600, replaced
// whole through a temp file). A device pairs once with a single-use 128-bit code
// that a paired desktop (or root on the PC, through the recovery socket) asks
// for. Codes live in memory only, for 10 minutes, and only their hashes are kept.

export const DEVICE_COOKIE = 'wr_device';
/** 400 days, the longest browsers keep a cookie; renewed on use. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 86_400;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const PAIR_ATTEMPTS_PER_MINUTE = 10;
export const PAIR_FAILURES_BEFORE_LOCK = 20;
export const MAX_DEVICES = 50;

const FILE = 'devices.json';
const SECRET_BYTES = 32;
const CODE_BYTES = 16;
const MAX_OPEN_CODES = 20;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** lastSeen (and the cookie's 400 days) move on at most this often, to keep writes rare. */
const TOUCH_EVERY_MS = HOUR_MS;
/** How many wr_device cookies one request may present (another loopback port can set one too). */
const MAX_PRESENTED = 3;

const DEVICE_ID = /^dv_[a-f0-9]{24}$/;
const COOKIE_VALUE = /^(dv_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const DEVICE_SCOPES: Record<DeviceKind, readonly DeviceScope[]> = {
  desktop: ['chats', 'settings', 'pc-settings', 'power', 'devices'],
  phone: ['chats', 'settings', 'power-confirm'],
};

/** A device name: one short line of plain text, no control or direction-changing characters. */
export const DeviceName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]*$/, 'one plain line');

export const DeviceIdParam = z.string().regex(DEVICE_ID, 'invalid device id');

const StoredDevice = z
  .object({
    id: z.string().regex(DEVICE_ID),
    name: z.string().min(1).max(60),
    kind: z.enum(DEVICE_KINDS),
    scopes: z.array(z.string()),
    created: z.number(),
    lastSeen: z.number(),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type StoredDevice = z.infer<typeof StoredDevice>;

const StoreFile = z
  .object({
    version: z.literal(1),
    devices: z.array(StoredDevice).max(MAX_DEVICES),
    pairingLocked: z.boolean().default(false),
  })
  .strict();

export class DevicesFileError extends Error {}

/** Why a pairing attempt was refused. `invalid` covers wrong, expired and used codes alike. */
export type PairRefusal = 'locked' | 'rate-limited' | 'invalid' | 'full';

export class PairingRefused extends Error {
  constructor(readonly reason: PairRefusal) {
    super(`pairing refused (${reason})`);
  }
}

export interface PairingCode {
  code: string;
  kind: DeviceKind;
  expiresAt: number;
}

export interface Authenticated {
  device: DeviceInfo;
  /** The cookie value that matched, to renew it. */
  cookie: string;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
/** Compared against when a cookie names no device, so a miss costs the same as a wrong secret. */
const NO_DEVICE_HASH = sha256('no such device');

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The wr_device values in a Cookie header (at most a few). */
export function readDeviceCookies(header: string | undefined): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== DEVICE_COOKIE) continue;
    values.push(part.slice(eq + 1).trim());
    if (values.length >= MAX_PRESENTED) break;
  }
  return values;
}

/** Whether a presented wr_device value has the shape of one this server sets. */
export function isDeviceCookieValue(value: string): boolean {
  return COOKIE_VALUE.test(value);
}

/** Set-Cookie for a device: HttpOnly, SameSite=Strict, Secure except on a loopback http origin. */
export function deviceCookie(value: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${value}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedDeviceCookie(secure: boolean): string {
  return `${DEVICE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/**
 * Which kind of device made a request: power actions and PC-only settings
 * depend on it. A request without a device (only possible with device sign-in
 * turned off, Cloudflare Access alone) counts as a phone, the more careful kind.
 */
export function deviceKind(request: { device?: DeviceInfo | undefined }): DeviceKind {
  return request.device?.kind ?? 'phone';
}

/** The device behind a power action or a presence report. */
export interface RequestDevice {
  /** The pairing id. */
  id: string;
  kind: DeviceKind;
}

/**
 * The paired device a power action or presence report comes from. Only a paired
 * device may control the PC: an Access sign-in alone (device sign-in turned off)
 * is nobody's desktop, so it is refused rather than given a kind.
 */
export function requestDevice(request: { device?: DeviceInfo | undefined }, devices: Pick<Devices, 'get'> | undefined): RequestDevice {
  // Authentication precedes body parsing: a device can be revoked while a
  // request's body is arriving, so only the live store may authorise its use.
  const device = request.device && devices?.get(request.device.id);
  if (!device) throw new UserFacingError('Pair this device before controlling the PC.', 403);
  return { id: device.id, kind: device.kind };
}

function view(device: StoredDevice): DeviceInfo {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    scopes: [...DEVICE_SCOPES[device.kind]],
    created: device.created,
    lastSeen: device.lastSeen,
  };
}

export class Devices {
  private readonly path: string;
  private readonly now: () => number;
  private readonly devices = new Map<string, StoredDevice>();
  /**
   * Open codes by the SHA-256 of the code, with the device that asked for each
   * (none for root's recovery path). Revoking that device voids its codes.
   */
  private readonly codes = new Map<string, { kind: DeviceKind; expiresAt: number; issuer?: string }>();
  private attempts: number[] = [];
  private failures: number[] = [];
  private locked = false;
  private readonly signals = new Map<string, AbortController>();
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(
    private readonly stateDir: string,
    options: { now?: () => number } = {},
  ) {
    this.path = join(stateDir, FILE);
    this.now = options.now ?? Date.now;
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new DevicesFileError(`Cannot read ${this.path}: ${(err as Error).message}`);
    }
    let file: z.infer<typeof StoreFile>;
    try {
      file = StoreFile.parse(JSON.parse(text));
    } catch {
      // Fail closed rather than start over: an empty list would be rewritten over it.
      throw new DevicesFileError(`${this.path} is damaged. Move it aside to start again (every device then pairs again).`);
    }
    for (const device of file.devices) this.devices.set(device.id, device);
    this.locked = file.pairingLocked;
  }

  /**
   * Writes the store. Changes to the device list pass the list they're about
   * to make (`devices`) and apply it in memory only once it's on disk: a
   * failed write then leaves both as they were, never a device that's gone
   * here but comes back after a restart (or the other way round).
   */
  private save(devices: Iterable<StoredDevice> = this.devices.values(), pairingLocked = this.locked): void {
    checkDeviceSignal();
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const file = { version: 1, devices: [...devices], pairingLocked };
    const tmp = join(this.stateDir, `.${FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const data = Buffer.from(`${JSON.stringify(file, null, 2)}\n`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      // A write can take less than it's given (a nearly full disk): keep going
      // until every byte is there, or fail, before the file replaces the store.
      for (let at = 0; at < data.length; ) {
        const wrote = writeSync(fd, data, at, data.length - at);
        if (wrote <= 0) throw new Error(`Cannot write ${this.path}: the disk took nothing`);
        at += wrote;
      }
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** The device list with `device` put in (or replaced) or, given an id, taken out. */
  private staged(change: StoredDevice | string): StoredDevice[] {
    const list = [...this.devices.values()];
    if (typeof change === 'string') return list.filter((d) => d.id !== change);
    return this.devices.has(change.id) ? list.map((d) => (d.id === change.id ? change : d)) : [...list, change];
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].sort((a, b) => a.created - b.created).map(view);
  }

  get(id: string): DeviceInfo | undefined {
    const device = this.devices.get(id);
    return device && view(device);
  }

  get size(): number {
    return this.devices.size;
  }

  /** The device a cookie value belongs to, compared in constant time; null if none. */
  authenticate(values: readonly string[]): Authenticated | null {
    for (const value of values.slice(0, MAX_PRESENTED)) {
      const match = COOKIE_VALUE.exec(value);
      if (!match) continue;
      const stored = this.devices.get(match[1]!);
      const expected = stored ? Buffer.from(stored.secretHash, 'hex') : NO_DEVICE_HASH;
      if (timingSafeEqual(sha256(match[2]!), expected) && stored) return { device: view(stored), cookie: value };
    }
    return null;
  }

  /**
   * Notes that a device was used. True when its cookie should be renewed (at
   * most hourly). Saved before it's applied, like every other change: a failed
   * write leaves lastSeen as it was, so the next request tries (and renews) again
   * instead of finding the hour already used up.
   */
  touch(id: string): boolean {
    const device = this.devices.get(id);
    const now = this.now();
    if (!device || now - device.lastSeen < TOUCH_EVERY_MS) return false;
    const seen = { ...device, lastSeen: now };
    this.save(this.staged(seen));
    this.devices.set(id, seen);
    return true;
  }

  rename(id: string, name: string): DeviceInfo | undefined {
    const device = this.devices.get(id);
    if (!device) return undefined;
    const renamed = { ...device, name: DeviceName.parse(name) };
    this.save(this.staged(renamed));
    this.devices.set(id, renamed);
    return view(renamed);
  }

  /**
   * Forgets a device; its cookie stops working at once, the codes it asked for
   * are voided and its open sockets are told to close.
   */
  revoke(id: string): boolean {
    if (!this.devices.has(id)) return false;
    // On disk first: if that fails the device stays paired, here and after a
    // restart, and the caller gets the error (nothing half-revoked).
    this.save(this.staged(id));
    this.devices.delete(id);
    this.signals.get(id)?.abort();
    this.signals.delete(id);
    for (const [key, open] of this.codes) if (open.issuer === id) this.codes.delete(key);
    for (const listener of this.revokeListeners) {
      try {
        listener(id);
      } catch {
        // A listener must not stop the others.
      }
    }
    return true;
  }

  /** All requests from this pairing share a signal; revoke aborts it before returning. */
  signal(id: string): AbortSignal {
    let controller = this.signals.get(id);
    if (!controller) {
      controller = new AbortController();
      if (this.devices.has(id)) this.signals.set(id, controller);
      else controller.abort();
    }
    return controller.signal;
  }

  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** Adds a device directly. Pairing goes through `pair`; this is its last step (and the demo's shortcut). */
  add(name: string, kind: DeviceKind): Authenticated {
    if (this.devices.size >= MAX_DEVICES) throw new PairingRefused('full');
    let id: string;
    do id = `dv_${randomBytes(12).toString('hex')}`;
    while (this.devices.has(id));
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const now = this.now();
    const device: StoredDevice = {
      id,
      name: DeviceName.parse(name),
      kind,
      scopes: [...DEVICE_SCOPES[kind]],
      created: now,
      lastSeen: now,
      secretHash: sha256(secret).toString('hex'),
    };
    this.save(this.staged(device));
    this.devices.set(id, device);
    return { device: view(device), cookie: `${id}.${secret}` };
  }

  // ---- Pairing codes ----------------------------------------------------------

  /**
   * A new single-use code for a device of `kind`. `issuer` is the paired device
   * that asked for it: the code dies with that device, so a revoked desktop
   * can't come back through a code it took beforehand. Codes without one come
   * from the PC itself (root's recovery path, the demo). Root's recovery path
   * also lifts a pairing lock: whoever is root on the PC is trusted more than
   * any device.
   */
  createCode(kind: DeviceKind, options: { recovery?: boolean; issuer?: string } = {}): PairingCode {
    const now = this.now();
    for (const [key, open] of this.codes) if (open.expiresAt <= now) this.codes.delete(key);
    while (this.codes.size >= MAX_OPEN_CODES) this.codes.delete(this.codes.keys().next().value!);
    if (options.recovery && this.locked) this.unlockPairing();
    const code = base32(randomBytes(CODE_BYTES));
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    this.codes.set(sha256(code).toString('hex'), { kind, expiresAt, ...(options.issuer ? { issuer: options.issuer } : {}) });
    return { code, kind, expiresAt };
  }

  /**
   * Pairs a new device with a code. The code is used up whether or not the rest
   * succeeds. A code for a phone can't make a desktop; one for a desktop may make
   * a phone. Wrong, expired and used codes all count towards the lock.
   */
  pair(code: string, name: string, kind?: DeviceKind): Authenticated {
    const now = this.now();
    if (this.locked) throw new PairingRefused('locked');
    this.attempts = this.attempts.filter((t) => now - t < MINUTE_MS);
    if (this.attempts.length >= PAIR_ATTEMPTS_PER_MINUTE) throw new PairingRefused('rate-limited');
    this.attempts.push(now);
    if (this.devices.size >= MAX_DEVICES) throw new PairingRefused('full');

    const normalized = normalizePairingCode(code);
    const key = CODE_RE.test(normalized) ? sha256(normalized).toString('hex') : null;
    const open = key ? this.codes.get(key) : undefined;
    if (key && open) this.codes.delete(key);
    const voided = open?.issuer !== undefined && !this.devices.has(open.issuer);
    if (!open || voided || open.expiresAt <= now || (kind === 'desktop' && open.kind === 'phone')) {
      this.fail(now);
      throw new PairingRefused('invalid');
    }
    return this.add(name, kind ?? open.kind);
  }

  private fail(now: number): void {
    this.failures = this.failures.filter((t) => now - t < HOUR_MS);
    this.failures.push(now);
    if (this.failures.length >= PAIR_FAILURES_BEFORE_LOCK) {
      this.locked = true;
      this.save();
    }
  }

  pairingLocked(): boolean {
    return this.locked;
  }

  /** Saved before it's applied: if the save fails, pairing stays locked. */
  unlockPairing(): void {
    if (this.locked) this.save(undefined, false);
    this.locked = false;
    this.failures = [];
    this.attempts = [];
  }
}
