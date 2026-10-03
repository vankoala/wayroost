import type { DeviceKind } from '../../shared/protocol';

// Small helpers for the pairing pages, kept apart from the components so they're testable.

/** A starting name for this device, from the browser's user agent; the person can change it. */
export function guessDeviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? 'Android phone' : 'Android tablet';
  if (/Electron|Wayroost/.test(userAgent)) return 'Desktop app';
  if (/Windows/.test(userAgent)) return 'Windows PC';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Linux|CrOS/.test(userAgent)) return 'Computer';
  return 'Browser';
}

/**
 * Reads the pairing code from a URL fragment ("#abcd…"). Codes are base32, so
 * anything else is ignored rather than posted.
 */
export function codeFromHash(hash: string): string | null {
  const code = normalizeCode(hash.replace(/^#/, ''));
  return /^[a-z2-7]{26}$/.test(code) ? code : null;
}

/** As the server reads a typed code: case, spaces and dashes don't matter. */
export function normalizeCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

/** A code in groups of four, easier to read out or type: "abcd-efgh-…". */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** "9:58", for how long a code has left. */
export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const KIND_LABEL: Record<DeviceKind, string> = { desktop: 'Desktop', phone: 'Phone' };
