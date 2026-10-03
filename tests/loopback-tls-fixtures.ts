import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfSignedLoopbackCertificate } from '../lib/self-signed-certificate.js';

export type LoopbackService = 'server' | 'supervisor';

/** Throwaway loopback certificates for one test run, in a temporary folder that `remove()` deletes. */
export interface LoopbackTlsFixtures {
  readonly directory: string;
  certFile(service: LoopbackService): string;
  keyFile(service: LoopbackService): string;
  cert(service: LoopbackService): Buffer;
  key(service: LoopbackService): Buffer;
  remove(): void;
}

/**
 * Generates a server and a supervisor key pair with the installers' own certificate code, so no
 * key material is ever committed. Fingerprints are computed from these files by each test.
 */
export function loopbackTlsFixtures(): LoopbackTlsFixtures {
  const directory = mkdtempSync(join(tmpdir(), 'wayroost-tls-fixtures-'));
  const certFile = (service: LoopbackService) => join(directory, `${service}-tls-cert.pem`);
  const keyFile = (service: LoopbackService) => join(directory, `${service}-tls-key.pem`);
  for (const service of ['server', 'supervisor'] as const) {
    const pair = selfSignedLoopbackCertificate();
    writeFileSync(certFile(service), pair.certificate, { mode: 0o644 });
    writeFileSync(keyFile(service), pair.privateKey, { mode: 0o600 });
  }
  return {
    directory,
    certFile,
    keyFile,
    cert: (service) => readFileSync(certFile(service)),
    key: (service) => readFileSync(keyFile(service)),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
