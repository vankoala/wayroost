// A real-Electron check of the desktop marker: the header must be seen on the wire,
// not inferred from unit tests. Run it on Windows (or any machine with a display) after a build:
//
//   npm run check:app-header
//
// Two local servers stand in for the app origin and an unrelated one. The app session gets the same
// installAppHeader as the real app, and the main process's net.WebSocket the same appSocketOptions (that
// socket bypasses the session's header hook); then the window's page load, its fetch and its WebSocket, and
// the main process's session.fetch and net.WebSocket all go to the app origin, and must carry x-wayroost-app.
// A fetch and a main-process socket to the other origin, and a request from the default (rescue) session, must not.
// Electron reports a refused upgrade on the main socket only through its close reason, so the check also reads
// real failures the way the server client does: 401 and 403 suspend approvals; 503, a server that closes before
// answering and a server that is down are recognized network failures and reconnect.
import { app, BrowserWindow, net, session } from 'electron';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_HEADER, appSocketOptions, installAppHeader } from './hardening.js';
import { socketCloseAction, socketCloseLoss } from './server-client.js';

const seen = new Map<string, IncomingHttpHeaders>();
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const other = createServer((req, res) => {
    seen.set('other origin', req.headers);
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
  });
  other.on('upgrade', (req, socket) => {
    seen.set('other origin net.WebSocket', req.headers);
    socket.destroy();
  });
  const otherPort = await listen(other);
  const appServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/') {
      seen.set('window page load', req.headers);
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><script>
        fetch('/api/probe').catch(() => {});
        fetch('http://127.0.0.1:${otherPort}/other').catch(() => {});
        const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onerror = () => {};
      </script>`);
      return;
    }
    seen.set(path === '/api/probe' ? 'window fetch' : path === '/api/main' ? 'main session.fetch' : `default session ${path}`, req.headers);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  appServer.on('upgrade', (req, socket) => {
    if (req.url === '/ws-refused-closed') { socket.destroy(); return; }
    const refusal = /^\/ws-refused-(\d{3})$/.exec(req.url ?? '')?.[1];
    if (refusal) {
      const body = refusal === '401' ? '{"error":"unpaired"}' : '{"error":"demo refusal"}';
      socket.end(`HTTP/1.1 ${refusal} Demo\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    seen.set(req.url === '/ws-main' ? 'main net.WebSocket' : 'window WebSocket', req.headers);
    socket.destroy();
  });
  const port = await listen(appServer);
  const origin = `http://127.0.0.1:${port}`;

  // A throwaway partition, set up exactly like persist:wayroost.
  const partition = session.fromPartition('wayroost-header-check');
  installAppHeader(partition, origin);
  const window = new BrowserWindow({ show: false, webPreferences: { session: partition, contextIsolation: true, sandbox: true } });
  await window.loadURL(origin);
  await partition.fetch(`${origin}/api/main`).catch(() => {});
  for (const url of [`ws://127.0.0.1:${port}/ws-main`, `ws://127.0.0.1:${otherPort}/ws-other`]) {
    const socket = new net.WebSocket(url, appSocketOptions(url, origin, partition)) as unknown as { onerror: unknown };
    socket.onerror = () => {};
  }
  await session.defaultSession.fetch(`${origin}/rescue`).catch(() => {});
  for (let i = 0; i < 50 && seen.size < 8; i++) await settle(100);
  // A port nothing listens on stands in for a server that is down.
  const down = createServer(); const downPort = await listen(down); await new Promise((resolve) => down.close(resolve));
  const refusals = new Map<string, string>();
  for (const [what, url] of [['401', `ws://127.0.0.1:${port}/ws-refused-401`], ['403', `ws://127.0.0.1:${port}/ws-refused-403`],
    ['503', `ws://127.0.0.1:${port}/ws-refused-503`], ['closed before answering', `ws://127.0.0.1:${port}/ws-refused-closed`],
    ['server down', `ws://127.0.0.1:${downPort}/ws`]] as const) {
    refusals.set(what, await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('no close'), 5000);
      const socket = new net.WebSocket(url, appSocketOptions(url, origin, partition)) as unknown as { onerror: unknown; onclose: unknown };
      socket.onerror = () => {};
      socket.onclose = (event: { code: number; reason?: string }) => { clearTimeout(timer); resolve(`${socketCloseAction(event, false)} (loss ${socketCloseLoss(event, false)})`); };
    }));
  }
  window.destroy();
  appServer.close(); other.close();

  let failed = 0;
  const expectMarker = (what: string, wanted: boolean) => {
    const headers = seen.get(what);
    const ok = headers !== undefined && (headers[APP_HEADER] === 'desktop') === wanted;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${what}: ${headers === undefined ? 'no request seen' : `${APP_HEADER} ${headers[APP_HEADER] ?? 'absent'}`}`);
  };
  for (const what of ['window page load', 'window fetch', 'window WebSocket', 'main session.fetch', 'main net.WebSocket']) expectMarker(what, true);
  expectMarker('other origin', false);
  expectMarker('other origin net.WebSocket', false);
  expectMarker('default session /rescue', false);
  for (const [what, wanted] of [['401', 'suspend (loss unpaired)'], ['403', 'suspend (loss unpaired)'], ['503', 'reconnect (loss null)'],
    ['closed before answering', 'reconnect (loss null)'], ['server down', 'reconnect (loss null)']] as const) {
    const ok = refusals.get(what) === wanted;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} main net.WebSocket failure (${what}): ${refusals.get(what)}`);
  }
  return failed ? 1 : 0;
}

void app.whenReady().then(main).then((code) => app.exit(code), (error: unknown) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
