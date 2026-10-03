import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { certificatePaths, createListenerCertificate, listenerFingerprints } from './tls-certificates.js';
import { spkiFingerprint, verifyPinnedCertificate } from '../lib/loopback-tls.js';
import { selfSignedLoopbackCertificate } from '../lib/self-signed-certificate.js';
import { pinnedRequest } from '../desktop/src/tls.js';

it('creates independent P-256 listener keys, retains them on reinstall and explicitly rotates the pin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-loopback-tls-'));
  try {
    const server = createListenerCertificate(directory, 'server');
    const supervisor = createListenerCertificate(directory, 'supervisor');
    expect(server).not.toBe(supervisor);
    const paths = certificatePaths(directory, 'server');
    const cert = new X509Certificate(readFileSync(paths.cert));
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1'); expect(cert.checkHost('localhost')).toBe('localhost');
    expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(3651 * 86400000);
    expect(() => verifyPinnedCertificate(cert.raw, server, '127.0.0.1')).not.toThrow();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 30_000);
    try { expect(() => verifyPinnedCertificate(cert.raw, server, '127.0.0.1')).not.toThrow(); }
    finally { clock.mockRestore(); }
    expect(statSync(paths.key).mode & 0o777).toBe(0o600); expect(statSync(paths.key).uid).toBe(process.getuid?.());
    expect(statSync(paths.cert).mode & 0o777).toBe(0o644);
    const listener = createServer({ cert: readFileSync(paths.cert), key: readFileSync(paths.key) }, (_request, response) => response.end('{}'));
    try {
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      const url = new URL(`https://127.0.0.1:${(listener.address() as AddressInfo).port}/demo`);
      expect((await pinnedRequest(url, server, {})).status).toBe(200);
    } finally { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
    expect(createListenerCertificate(directory, 'server')).toBe(server);
    const rotated = createListenerCertificate(directory, 'server', true);
    expect(rotated).not.toBe(server);
    expect(rotated).toBe(spkiFingerprint(readFileSync(paths.cert)));
    expect(() => verifyPinnedCertificate(readFileSync(paths.cert), server, '127.0.0.1')).toThrow('This is not your Wayroost server');
    rmSync(paths.key);
    expect(() => createListenerCertificate(directory, 'server')).toThrow('Incomplete TLS');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('encodes validity through and beyond the X.509 2050 time boundary', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2049-01-01T00:00:00Z'));
  try {
    const cert = new X509Certificate(selfSignedLoopbackCertificate().certificate);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(Date.parse(cert.validFrom)).toBe(Date.parse('2048-12-31T00:00:00Z'));
    expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(3651 * 86400000);
  } finally { clock.mockRestore(); }
});

it('refuses to retain a malformed, expired or mismatched certificate pair without silently changing pins', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-tls-retain-'));
  try {
    createListenerCertificate(directory, 'server');
    const paths = certificatePaths(directory, 'server');
    const cert = readFileSync(paths.cert);
    const key = readFileSync(paths.key);
    writeFileSync(paths.cert, 'demo-invalid-certificate');
    expect(() => createListenerCertificate(directory, 'server')).toThrow('rotate-tls');
    writeFileSync(paths.cert, cert);
    writeFileSync(paths.key, selfSignedLoopbackCertificate().privateKey);
    expect(() => createListenerCertificate(directory, 'server')).toThrow('rotate-tls');
    writeFileSync(paths.key, key);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(new X509Certificate(cert).validTo) + 1);
    try { expect(() => createListenerCertificate(directory, 'server')).toThrow('rotate-tls'); }
    finally { clock.mockRestore(); }
    expect(readFileSync(paths.cert)).toEqual(cert);
    expect(readFileSync(paths.key)).toEqual(key);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('runs the CLI through a symlink instead of silently exiting successfully', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-tls-cli-'));
  try {
    const link = join(directory, 'tls-certificates.ts');
    symlinkSync(new URL('./tls-certificates.ts', import.meta.url), link);
    const result = spawnSync(process.execPath, ['--import', 'tsx', link, 'demo-invalid-service', 'rotate'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage:|as root/);
    expect(result.stdout).toBe('');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('prints fingerprints offline using public files only, without listener contact or private keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-tls-fingerprints-'));
  try {
    const server = createListenerCertificate(directory, 'server');
    const supervisor = createListenerCertificate(directory, 'supervisor');
    rmSync(certificatePaths(directory, 'server').key); rmSync(certificatePaths(directory, 'supervisor').key);
    expect(listenerFingerprints(directory)).toBe(`server fingerprint: ${server}\nsupervisor fingerprint: ${supervisor}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('requires a supervisor certificate and confirmed TLS tool output before installer continuation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-tls-install-'));
  try {
    const source = new URL('../deploy/wayroost-lib.sh', import.meta.url).pathname;
    const check = () => spawnSync('bash', ['-c', 'source "$1"; DRY_RUN=0; ROOT_PREFIX="$2"; require_supervisor_tls', 'demo', source, directory], { encoding: 'utf8' });
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('re-run install-supervisor.sh') });
    mkdirSync(join(directory, 'etc/wayroost'), { recursive: true });
    writeFileSync(join(directory, 'etc/wayroost/supervisor-tls-cert.pem'), selfSignedLoopbackCertificate().certificate);
    expect(check().status).toBe(0);
    const tool = join(directory, 'fake-node'); writeFileSync(tool, '#!/bin/sh\nexit 0\n'); chmodSync(tool, 0o755);
    const result = spawnSync('bash', ['-c', 'source "$1"; DRY_RUN=0; NODE="$2"; install_tls server /demo/tool', 'demo', source, tool], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('did not confirm a fingerprint');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
