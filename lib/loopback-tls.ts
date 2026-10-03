import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerOptions } from 'node:https';

export interface ListenerTls { certFile: string; keyFile?: string }
export const TLS_CERT_CREDENTIAL = 'loopback-tls-cert';
export const TLS_KEY_CREDENTIAL = 'loopback-tls-key';

export function spkiFingerprint(certificate: string | Buffer): string {
  const cert = new X509Certificate(certificate);
  return 'sha256/' + createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

export function parsePin(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(value.trim())) throw new Error('Enter the SHA-256 fingerprint printed on this PC.');
  const pin = value.trim();
  if (Buffer.from(pin.slice(7), 'base64').toString('base64') !== pin.slice(7)) throw new Error('Invalid SHA-256 fingerprint.');
  return pin;
}

export class ListenerIdentityError extends Error {
  constructor(listener = 'server') { super(`This is not your Wayroost ${listener}. No credentials were sent. Run sudo wayroost pair-desktop on this PC to pair again.`); }
}
export class ListenerNotPairedError extends Error {
  constructor() { super('This desktop has not been paired with the listener. Run sudo wayroost pair-desktop on this PC.'); }
}
export class ListenerCertificateDateError extends Error {
  constructor() { super('The listener certificate expired or the PC clock is wrong. Check the clock; if expired, run sudo wayroost rotate-tls server or supervisor for the affected listener, then pair again.'); }
}

export function verifyPinnedCertificate(certificate: string | Buffer, pin: string | undefined, hostname: string): void {
  if (!pin) throw new ListenerNotPairedError();
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificate);
    if (parsePin(pin) !== spkiFingerprint(certificate) ||
      !(hostname === '127.0.0.1' ? cert.checkIP(hostname) : hostname === 'localhost' && cert.checkHost(hostname, { subject: 'never' }))) throw new Error('identity');
  } catch { throw new ListenerIdentityError(); }
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo)) throw new ListenerCertificateDateError();
}

/** Installed listeners use only systemd's service-private copies of the keys. */
export function listenerTls(config: ListenerTls, env: NodeJS.ProcessEnv = process.env, development = false): ServerOptions {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir && !development) throw new Error('Installed TLS requires systemd LoadCredential.');
  try {
    return {
      cert: readFileSync(dir ? join(dir, TLS_CERT_CREDENTIAL) : config.certFile),
      key: readFileSync(dir ? join(dir, TLS_KEY_CREDENTIAL) : config.keyFile ?? ''),
      minVersion: 'TLSv1.2',
    };
  } catch { throw new Error('Cannot read the loopback TLS credentials.'); }
}
