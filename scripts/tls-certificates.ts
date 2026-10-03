import { createPrivateKey, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spkiFingerprint } from '../lib/loopback-tls.js';
import { selfSignedLoopbackCertificate } from '../lib/self-signed-certificate.js';

export function certificatePaths(directory: string, service: 'server' | 'supervisor') {
  return { cert: join(directory, `${service}-tls-cert.pem`), key: join(directory, `${service}-tls-key.pem`) };
}

/** Used by installers and root's explicit rotation command; never emits key material. */
export function createListenerCertificate(directory: string, service: 'server' | 'supervisor', rotate = false): string {
  const paths = certificatePaths(directory, service);
  if (!rotate && (existsSync(paths.cert) || existsSync(paths.key))) {
    if (!existsSync(paths.cert) || !existsSync(paths.key)) throw new Error('Incomplete TLS certificate pair; restore it or explicitly rotate it.');
    if ((statSync(paths.key).mode & 0o777) !== 0o600 || statSync(paths.key).uid !== process.getuid?.()) throw new Error('TLS private key must be service-installer owned, mode 0600.');
    try {
      const cert = new X509Certificate(readFileSync(paths.cert));
      if (!cert.verify(cert.publicKey) || !cert.checkPrivateKey(createPrivateKey(readFileSync(paths.key))) ||
        Date.now() > Date.parse(cert.validTo) || !cert.checkIP('127.0.0.1') || !cert.checkHost('localhost', { subject: 'never' })) throw new Error('invalid pair');
      return spkiFingerprint(cert.raw);
    } catch { throw new Error(`Invalid or expired ${service} TLS certificate pair; run sudo wayroost rotate-tls ${service}.`); }
  }
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  const stage = mkdtempSync(join(directory, '.tls-'));
  chmodSync(stage, 0o700);
  try {
    const key = join(stage, 'key.pem');
    const cert = join(stage, 'cert.pem');
    const pair = selfSignedLoopbackCertificate();
    writeFileSync(key, pair.privateKey, { mode: 0o600, flag: 'wx' });
    chmodSync(key, 0o600);
    writeFileSync(cert, pair.certificate, { mode: 0o644, flag: 'wx' });
    chmodSync(cert, 0o644);
    const certificate = new X509Certificate(readFileSync(cert));
    if (!certificate.verify(certificate.publicKey)) throw new Error('Could not verify the generated loopback certificate.');
    const pin = spkiFingerprint(certificate.raw);
    renameSync(key, paths.key);
    renameSync(cert, paths.cert);
    return pin;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function listenerFingerprints(directory: string): string {
  return (['server', 'supervisor'] as const).map(service => `${service} fingerprint: ${spkiFingerprint(readFileSync(certificatePaths(directory, service).cert))}`).join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.getuid?.() !== 0) throw new Error('Run the TLS installer or rotation command as root.');
    const [service, operation] = process.argv.slice(2);
    if (service === 'fingerprints' && process.argv.length === 3) {
      console.log(listenerFingerprints('/etc/wayroost'));
    } else {
      if ((service !== 'server' && service !== 'supervisor') || !['create', 'rotate'].includes(operation ?? '') || process.argv.length !== 4) throw new Error('Usage: tls-certificates <server|supervisor> <create|rotate> | fingerprints');
      console.log(`${service} fingerprint: ${createListenerCertificate('/etc/wayroost', service, operation === 'rotate')}`);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'TLS certificate operation failed.'); process.exitCode = 1; }
}
