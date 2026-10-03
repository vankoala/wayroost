// Windows CI: real Electron transports against invented loopback TLS listeners.
import { app, BrowserWindow, net, safeStorage, session } from 'electron';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spkiFingerprint } from '../../lib/loopback-tls.js';
import { selfSignedLoopbackCertificate } from '../../lib/self-signed-certificate.js';
import { APP_HEADER, appSocketOptions, installAppHeader } from './hardening.js';
import { installCertificatePin, pairPinnedDesktop, pinnedOriginRequest } from './tls.js';
import { RescueClient } from './rescue-client.js';

const folder = mkdtempSync(join(tmpdir(), 'demo-wayroost-tls-'));
app.setPath('userData', folder);
app.on('window-all-closed', () => {});
// Throwaway pairs, generated for this run and kept in memory only.
const fixture = () => {
  const pair = selfSignedLoopbackCertificate();
  return { cert: Buffer.from(pair.certificate), key: Buffer.from(pair.privateKey) };
};
const original = fixture(); const rotated = fixture();
const origin = 'https://127.0.0.1:8896';
let bytes = 0; const paths = new Set<string>(); const markers = new Map<string, unknown>();
let listener: Server | undefined;
async function start(material: typeof original) {
  bytes = 0; paths.clear();
  listener = createServer(material, (request, response) => {
    paths.add(request.url!);
    if (['/page', '/renderer-fetch', '/native-fetch'].includes(request.url ?? '')) assert.match(request.headers.cookie ?? '', /wr_device=demo-cookie/);
    if (['/rescue-session', '/v1/status'].includes(request.url ?? '')) assert.equal(request.headers.authorization, 'Bearer demo-rescue-key');
    if (request.url === '/page') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Demo TLS</title>');
    } else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ overall: 'ok', sentence: 'Demo running.', components: [], at: 0 })); }
  });
  listener.on('secureConnection', socket => socket.on('data', chunk => { bytes += chunk.length; }));
  listener.on('upgrade', (request, socket) => {
    paths.add(request.url!); markers.set(request.url!, request.headers[APP_HEADER]); assert.match(request.headers.cookie ?? '', /wr_device=demo-cookie/);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>(resolve => listener!.listen(8896, '127.0.0.1', resolve));
}
async function stop() {
  if (!listener) return;
  listener.closeAllConnections();
  await new Promise<void>(resolve => listener!.close(() => resolve())); listener = undefined;
}
// The same options as the app's own socket: the explicit marker must still wait for the pinned handshake.
async function nativeSocket(target: Electron.Session, path: string, pin: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Native socket check timed out.')); }, 5000);
    const url = origin.replace('https:', 'wss:') + path;
    const socket = new net.WebSocket(url, appSocketOptions(url, origin, target, (value) => pinnedOriginRequest(value, origin, pin)));
    socket.onerror = () => { clearTimeout(timer); resolve(); };
    socket.onclose = () => { clearTimeout(timer); resolve(); };
    socket.onopen = () => { socket.close(); clearTimeout(timer); resolve(); };
  });
}
async function rendererSocket(window: BrowserWindow, path: string) {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const socket = new WebSocket(${JSON.stringify(origin.replace('https:', 'wss:') + path)});
    socket.onerror = () => resolve('error'); socket.onclose = () => resolve('closed');
    socket.onopen = () => { socket.close(); resolve('open'); };
    setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
  })`);
}
void app.whenReady().then(async () => {
  const pin = spkiFingerprint(original.cert);
  const partition = session.fromPartition('persist:wayroost');
  const rescueSession = session.fromPartition('wayroost-rescue');
  const install = (target: Electron.Session) => {
    installCertificatePin(target, origin, () => pin);
    installAppHeader(target, origin, url => pinnedOriginRequest(url, origin, pin));
  };
  install(partition); install(rescueSession);
  await partition.cookies.set({ url: origin, name: 'wr_device', value: 'demo-cookie', secure: true, httpOnly: true });
  const window = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const rescue = new RescueClient(origin, async () => 'demo-rescue-key', { pin: () => pin });
  try {
    assert(safeStorage.isEncryptionAvailable(), 'Windows encrypted storage unavailable');
    assert.equal(safeStorage.decryptString(safeStorage.encryptString(pin)), pin);
    await start(original);
    await window.loadURL(`${origin}/page`);
    await window.webContents.executeJavaScript(`fetch(${JSON.stringify(`${origin}/renderer-fetch`)}, {credentials:'include'}).then(r => r.json())`);
    await rendererSocket(window, '/renderer-ws');
    await partition.fetch(`${origin}/native-fetch`, { credentials: 'include' });
    await nativeSocket(partition, '/native-ws', pin);
    await rescueSession.fetch(`${origin}/rescue-session`, { headers: { Authorization: 'Bearer demo-rescue-key' } });
    await rescue.status();
    for (const path of ['/page', '/renderer-fetch', '/renderer-ws', '/native-fetch', '/native-ws', '/rescue-session', '/v1/status']) assert(paths.has(path), `Matching transport missing: ${path}`);
    for (const path of ['/renderer-ws', '/native-ws']) assert.equal(markers.get(path), 'desktop', `Desktop marker missing: ${path}`);
    await partition.closeAllConnections(); await rescueSession.closeAllConnections(); await stop();
    // Same origin and same sessions: the listener now holds a different private key.
    await start(rotated);
    await assert.rejects(partition.fetch(`${origin}/native-mismatch`, { credentials: 'include' }));
    await assert.rejects(rescueSession.fetch(`${origin}/rescue-mismatch`, { headers: { Authorization: 'Bearer demo-rescue-key' } }));
    await assert.rejects(rescue.status(), /This is not your Wayroost server/);
    await assert.rejects(rescue.restart(), /This is not your Wayroost server/);
    await assert.rejects(pairPinnedDesktop(origin, { code: 'a'.repeat(26), serverPin: pin, rescuePin: pin }), /This is not your Wayroost server/);
    await nativeSocket(partition, '/native-ws-mismatch', pin);
    await window.webContents.executeJavaScript(`fetch(${JSON.stringify(`${origin}/renderer-mismatch`)}, {credentials:'include'}).then(() => {throw Error('Unexpected success')}, () => 'blocked')`);
    await rendererSocket(window, '/renderer-ws-mismatch');
    await assert.rejects(window.loadURL(`${origin}/page-mismatch`));
    assert.equal(paths.size, 0, 'A mismatch reached an HTTP handler or WebSocket upgrade');
    assert.equal(bytes, 0, 'A mismatch sent HTTP application bytes to the fake socket');
    // A fresh session with an explicitly supplied new pin accepts the rotated listener.
    const repinned = session.fromPartition('demo-explicit-repin');
    const newPin = spkiFingerprint(rotated.cert);
    installCertificatePin(repinned, origin, () => newPin);
    installAppHeader(repinned, origin, url => pinnedOriginRequest(url, origin, newPin));
    await repinned.fetch(`${origin}/explicit-repin`);
    console.log('PASS Electron pinned page, renderer HTTP/WSS, session.fetch, net.WebSocket, rescue session/native; rotation rejects with zero socket bytes; explicit re-pin and Windows encryption');
  } finally { window.destroy(); await stop(); }
}).then(() => { app.exit(0); }).catch(error => { console.error(error instanceof Error ? error.message : 'TLS check failed'); app.exit(1); });
app.on('will-quit', () => rmSync(folder, { recursive: true, force: true }));
