import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Session } from 'electron';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { spkiFingerprint, verifyPinnedCertificate } from '../../lib/loopback-tls.js';
import { localListenerPort, localListenerOrigin, parseListenerPins, desktopOrigin, installCertificatePin, pairPinnedDesktop, parsePairingToken, pinnedOriginRequest, pinnedRequest } from '../src/tls.js';
import { RescueClient } from '../src/rescue-client.js';
import { installAppHeader } from '../src/hardening.js';
import { loopbackTlsFixtures } from '../../tests/loopback-tls-fixtures.js';

// Throwaway key pairs, generated for this run and removed afterwards; none is committed.
const tls = loopbackTlsFixtures();
afterAll(() => tls.remove());
const cert = tls.cert('server');
const key = tls.key('server');
const otherCert = tls.cert('supervisor');
const pin = spkiFingerprint(cert);
const otherPin = spkiFingerprint(otherCert);
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function listener() {
  let bytes = 0; let requests = 0;
  const server = createServer({ cert, key }, (_request, response) => {
    requests += 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ sentence: 'Demo running.', components: [], overall: 'ok', at: 0 }));
  });
  server.on('secureConnection', socket => socket.on('data', chunk => { bytes += chunk.length; }));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, sent: () => ({ bytes, requests }) };
}

describe('listener pinning', () => {
  it('checks the actual SPKI, SAN and pin format, with no trust on first use', () => {
    expect(() => verifyPinnedCertificate(cert, pin, '127.0.0.1')).not.toThrow();
    expect(() => verifyPinnedCertificate(cert, pin, 'localhost')).not.toThrow();
    for (const [certificate, stored, hostname] of [[cert, otherPin, '127.0.0.1'], [otherCert, pin, '127.0.0.1'], [cert, pin, 'example.com']] as const) {
      expect(() => verifyPinnedCertificate(certificate, stored, hostname)).toThrow('This is not your Wayroost server');
    }
    expect(parsePairingToken(JSON.stringify({ code: 'AAAAA-AAAAA AAAAA-AAAAA AAAAAA', serverPin: pin, rescuePin: otherPin }))).toMatchObject({ code: 'a'.repeat(26), serverPin: pin, rescuePin: otherPin });
    for (const code of ['a'.repeat(22), '1'.repeat(26), 'a'.repeat(27)]) expect(() => parsePairingToken(JSON.stringify({ code, serverPin: pin, rescuePin: otherPin }))).toThrow('Invalid desktop pairing token');
    expect(() => parsePairingToken('AAAAAAAAAAAAAAAAAAAAAA')).toThrow('pairing token');
  });
  it('requires an explicit dev flag for HTTP and rejects other hosts', () => {
    expect(() => desktopOrigin('http://127.0.0.1:8896')).toThrow('HTTPS');
    expect(desktopOrigin('http://127.0.0.1:8896', true)).toContain('http:');
    expect(() => desktopOrigin('https://example.com')).toThrow();
    expect(() => new RescueClient('http://127.0.0.1:8897', async () => 'demo-rescue-key')).toThrow();
  });
  it('rejects expired and not-yet-valid certificates even when the pin matches', () => {
    const certificate = new X509Certificate(cert);
    const time = vi.spyOn(Date, 'now');
    try {
      time.mockReturnValue(Date.parse(certificate.validTo) + 1);
      expect(() => verifyPinnedCertificate(cert, pin, '127.0.0.1')).toThrow('certificate expired or the PC clock is wrong');
      time.mockReturnValue(Date.parse(certificate.validFrom) - 1);
      expect(() => verifyPinnedCertificate(cert, pin, '127.0.0.1')).toThrow('certificate expired or the PC clock is wrong');
    } finally { time.mockRestore(); }
  });
  it('accepts only pinned origins, including WSS, and blocks downgrades and other ports before headers', () => {
    const origin = 'https://127.0.0.1:8896';
    let handler!: (details: Electron.OnBeforeSendHeadersListenerDetails, callback: (response: Electron.BeforeSendResponse) => void) => void;
    const target = { webRequest: { onBeforeSendHeaders: (_filter: unknown, callback: typeof handler) => { handler = callback; } } } as unknown as Session;
    installAppHeader(target, origin, url => pinnedOriginRequest(url, origin, pin));
    for (const url of [`${origin}/api/me`, 'wss://127.0.0.1:8896/ws']) {
      const callback = vi.fn(); handler!({ url, requestHeaders: { Cookie: 'wr_device=demo-secret' } } as unknown as Electron.OnBeforeSendHeadersListenerDetails, callback);
      expect(callback).toHaveBeenCalledWith({ requestHeaders: { Cookie: 'wr_device=demo-secret', 'x-wayroost-app': 'desktop' } });
    }
    for (const url of ['http://127.0.0.1:8896', 'https://127.0.0.1:8897', 'https://example.com']) {
      const callback = vi.fn(); handler!({ url, requestHeaders: { Cookie: 'wr_device=demo-secret' } } as unknown as Electron.OnBeforeSendHeadersListenerDetails, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    expect(pinnedOriginRequest(origin, origin, undefined)).toBe(false);
  });
  it('uses the same certificate verifier for renderer HTTP/WS and native session.fetch/net.WebSocket', () => {
    let verify!: NonNullable<Parameters<Session['setCertificateVerifyProc']>[0]>;
    const failed = vi.fn();
    installCertificatePin({ setCertificateVerifyProc: callback => { verify = callback!; } }, 'https://127.0.0.1:8896', () => pin, failed);
    for (const [hostname, certificate, accepted] of [['127.0.0.1', cert, 0], ['127.0.0.1', otherCert, -2], ['example.com', cert, -2]] as const) {
      const callback = vi.fn(); verify({ hostname, certificate: { data: certificate.toString() } } as Electron.Request, callback);
      expect(callback).toHaveBeenCalledWith(accepted);
    }
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it('sends native HTTP only after a matching handshake', async () => {
    const fake = await listener();
    const response = await pinnedRequest(new URL('/api/me', fake.origin), pin, { Cookie: 'wr_device=demo-secret' });
    expect(response.status).toBe(200); expect(fake.sent().requests).toBe(1); expect(fake.sent().bytes).toBeGreaterThan(0);
  });
  it.each([undefined, ''])('does not connect or report an impostor when unpaired (%j)', async pin => {
    const fake = await listener();
    const connections = vi.fn(); servers.at(-1)!.on('connection', connections);
    await expect(pinnedRequest(new URL('/api/me', fake.origin), pin, { Cookie: 'wr_device=demo-secret' })).rejects.toThrow('has not been paired');
    expect(connections).not.toHaveBeenCalled();
    expect(fake.sent()).toEqual({ bytes: 0, requests: 0 });
  });
  it('sends zero HTTP bytes, cookies or pairing body to a listener with a different key', async () => {
    const fake = await listener();
    await expect(pinnedRequest(new URL('/api/pair', fake.origin), otherPin, { Cookie: 'wr_device=demo-secret', 'x-wayroost-app': 'desktop' }, JSON.stringify({ code: 'demo-code' }))).rejects.toThrow('This is not your Wayroost server');
    await expect(pairPinnedDesktop(fake.origin, { code: 'a'.repeat(26), serverPin: otherPin, rescuePin: pin })).rejects.toThrow('This is not your Wayroost server');
    expect(fake.sent()).toEqual({ bytes: 0, requests: 0 });
  });
  it('sends zero rescue bearer bytes on mismatch, and works with the correct pin', async () => {
    const fake = await listener();
    const wrong = new RescueClient(fake.origin, async () => 'demo-rescue-key', { pin: () => otherPin });
    await expect(wrong.status()).rejects.toThrow('This is not your Wayroost server');
    await expect(wrong.restart()).rejects.toThrow('This is not your Wayroost server');
    expect(fake.sent()).toEqual({ bytes: 0, requests: 0 });
    const correct = new RescueClient(fake.origin, async () => 'demo-rescue-key', { pin: () => pin });
    expect(await correct.status()).toMatchObject({ overall: 'ok' }); expect(fake.sent().requests).toBe(1);
  });
  it.each(['status', 'restart'] as const)('keeps the pin bound to a %s request while its key is pending', async action => {
    const fake = await listener();
    let savedPin = otherPin;
    let supplyKey!: (key: string) => void;
    const pendingKey = new Promise<string>(resolve => { supplyKey = resolve; });
    const client = new RescueClient(fake.origin, () => pendingKey, { pin: () => savedPin });
    const request = client[action]();
    savedPin = pin;
    const rejected = expect(request).rejects.toThrow('This is not your Wayroost server');
    supplyKey('demo-original-key');
    await rejected;
    expect(fake.sent()).toEqual({ bytes: 0, requests: 0 });
  });
});


it('persists the local listener port with its TLS pin and defaults older pins to 8883', () => {
  expect(parseListenerPins({ serverPin: pin, rescuePin: otherPin })).toEqual({ serverPin: pin, rescuePin: otherPin, localPort: 8883 });
  const token = parsePairingToken(JSON.stringify({ code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA', serverPin: pin, rescuePin: otherPin, localPort: 8883 }));
  expect(localListenerOrigin(token)).toBe('https://127.0.0.1:8883');
  expect(parseListenerPins(JSON.parse(JSON.stringify(token))).localPort).toBe(8883);
  expect(pinnedOriginRequest('https://127.0.0.1:8881/api/settings/apply', localListenerOrigin(token), token.serverPin)).toBe(false);
  expect(pinnedOriginRequest('https://127.0.0.1:8883/api/settings/apply', localListenerOrigin(token), token.serverPin)).toBe(true);
  for (const value of [0, -1, 65536, 8881, 8880, '8883', 8883.5]) expect(() => localListenerPort(value)).toThrow();
});

it.each([
  [443, 'https://127.0.0.1'],
  [8883, 'https://127.0.0.1:8883'],
] as const)('uses the canonical HTTPS origin for local listener port %s', (localPort, origin) => {
  const token = parsePairingToken(JSON.stringify({ code: 'a'.repeat(26), serverPin: pin, rescuePin: otherPin, localPort }));
  const saved = parseListenerPins(JSON.parse(JSON.stringify(token)));
  expect(saved.localPort).toBe(localPort);
  expect(localListenerOrigin(token)).toBe(origin);
  expect(localListenerOrigin(saved)).toBe(origin);
  expect(desktopOrigin(localListenerOrigin(saved))).toBe(origin);
  expect(pinnedOriginRequest(`${origin}/api/me`, localListenerOrigin(saved), pin)).toBe(true);
  expect(pinnedOriginRequest(`${origin.replace('https:', 'wss:')}/ws`, localListenerOrigin(saved), pin)).toBe(true);
});
