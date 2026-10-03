import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toastXml, escapeXml, toastDetail, detailEms, TOAST_DETAIL_EM, TOAST_DETAIL_MAX } from '../src/toast.js';
import { approvalKey, approvalUrl, openApprovalView, rescueInFront, resolveActivation, runActivation, toastCanAllow, ToastTickets } from '../src/approvals.js';
import type { Approval } from '../../shared/protocol.js';
import { parseActivation, activationFromArgv, navigationKind } from '../src/protocol.js';
import { healthStatus, trayState } from '../src/tray-state.js';
import { AppLink, AppPage, presentRescue, restoreShowsApp, shared } from '../src/connection.js';
import { checkRescueKey, RescueClient, RescueUnauthorized } from '../src/rescue-client.js';
import type { SupervisorStatus } from '../../shared/supervisor.js';

const status: SupervisorStatus = { overall: 'ok', sentence: 'Everything is running.', components: [], at: 0 };
const nonce = 'DEMOnonceDEMOnonce_-01';
describe('recovery instructions', () => {
  it('distinguishes the saved supervisor rescue key from a desktop pairing code', () => {
    const form = readFileSync(new URL('../src/rescue.html', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const text of [form, readme]) {
      expect(text).toContain('supervisor rescue key');
      expect(text).toMatch(/install-time key[\s\S]*show[ns] once during supervisor\s+installation/);
      // The pairing code comes from the installed wrapper, never from the rescue key.
      expect(text).toContain('sudo wayroost pair-desktop');
      expect(text).toContain('does not supply the rescue');
    }
    expect(form).toContain('Desktop pairing token');
    expect(form).toContain('Supervisor rescue fingerprint');
  });
});
describe('toast XML', () => {
  it('escapes text and both activation attributes', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    const xml = toastXml('Coder <&>', `Approve "demo" & 'test'.`, 'demo:approval', nonce, { detail: 'ls <demo> & "x"', allowOnce: true });
    expect(xml).toContain('<text>Coder &lt;&amp;&gt;</text>');
    expect(xml).toContain('Approve &quot;demo&quot; &amp; &apos;test&apos;.');
    expect(xml).toContain(`launch="wayroost://approval/demo:approval/open/${nonce}"`);
    expect(xml).toContain(`content="Allow once" activationType="protocol" arguments="wayroost://approval/demo:approval/allow-once/${nonce}"`);
    expect(xml).toContain('content="Open" activationType="protocol"');
    expect(xml).toContain('<text hint-maxLines="2">ls &lt;demo&gt; &amp; &quot;x&quot;</text>');
    expect(xml.match(/<action /g)).toHaveLength(2);
    expect(() => toastXml('Coder', 'Needs you.', '<bad>', nonce, { allowOnce: false })).toThrow();
    expect(() => toastXml('Coder', 'Needs you.', 'demo', 'short', { allowOnce: false })).toThrow();
  });
  it('offers only Open when the toast may not allow', () => {
    const xml = toastXml('Agent', 'Agent is asking: Read README.', 'demo', nonce, { detail: 'rm -rf /home/me/demo\necho done', allowOnce: false });
    expect(xml.match(/<action /g)).toHaveLength(1);
    expect(xml).not.toContain('Allow once'); expect(xml).not.toContain('allow-once');
    expect(xml).toContain('<text hint-maxLines="2">rm -rf /home/me/demo echo done</text>');
  });
  it('shows the detail whole or says it is not', () => {
    const bidi = String.fromCodePoint(0x202e);
    expect(toastDetail('git status')).toEqual({ line: 'git status', whole: true });
    expect(toastDetail('rm -rf /home/me/demo').whole).toBe(true);
    const long = toastDetail('x'.repeat(TOAST_DETAIL_MAX + 1));
    expect(long.whole).toBe(false); expect(long.line).toHaveLength(TOAST_DETAIL_MAX); expect(long.line!.endsWith('…')).toBe(true);
    for (const detail of ['ls\nrm -rf /home/me', 'ls\trm', `ls ${bidi}fdp.txt`, 'ls\u0000']) expect(toastDetail(detail).whole).toBe(false);
    expect(toastDetail(`ls ${bidi}x`).line).toBe('ls  x');
  });
  it('emits only XML 1.0 characters and never splits a code point', () => {
    const legal = (xml: string) => !/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(xml);
    expect(escapeXml('a\uFFFEb\uFFFFc\uD800d\uDC00e')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe');
    expect(escapeXml('ok \u{1F600} \u754c')).toBe('ok \u{1F600} \u754c');
    const emoji = '\u{1F600}';
    const xml = toastXml('Agent\uFFFF', `${'x'.repeat(88)}${emoji} and more`, 'demo', nonce, { detail: `${'y'.repeat(TOAST_DETAIL_MAX - 2)}${emoji}tail\uD800`, allowOnce: false });
    expect(legal(xml)).toBe(true);
    expect(xml).toContain(`${'x'.repeat(88)}${emoji}…`);
    expect(xml).toContain(`${'y'.repeat(TOAST_DETAIL_MAX - 2)}${emoji}…`);
    expect(xml).toContain('<text>Agent\uFFFD</text>');
  });
  it('never calls a missing, blank or unbounded detail whole', () => {
    // Without a detail the toast shows only the agent-written title: nothing to allow from.
    for (const detail of [undefined, '', '   ', '.-/']) expect(toastDetail(detail).whole).toBe(false);
    // Line and paragraph separators break lines in a toast; the detail line shows them as spaces.
    const separated = 'pwd\u2028# harmless\u2028rm /tmp/demo';
    expect(toastDetail(separated)).toEqual({ line: 'pwd # harmless rm /tmp/demo', whole: false });
    expect(toastDetail('pwd\u2029rm /tmp/demo').whole).toBe(false);
    // Wide glyphs and invisible text have no width bound; only printable ASCII can be shown whole.
    for (const detail of ['ls \u{1F600}', 'ls \u754c', 'ls\u00a0x', 'ls \u200bx', 'ls\u3000x', 'e\u0301cho x']) expect(toastDetail(detail).whole).toBe(false);
    // The width budget, not a character count, decides: 20 Ws are too wide, 30 lowercase letters are not.
    expect(toastDetail('W'.repeat(20)).whole).toBe(false);
    expect(toastDetail('a'.repeat(30)).whole).toBe(true);
    expect(detailEms('W'.repeat(20))).toBeGreaterThan(TOAST_DETAIL_EM);
    expect(toastDetail(`echo ${'x'.repeat(40)}`).whole).toBe(false);
  });
});
describe('protocol', () => {
  it.each(['allow-once', 'open'])('uses only the selected protocol for toast %s activations', action => {
    const url = `wayroost-dev://approval/demo/${action}/${nonce}`;
    const activation = { id: 'demo', action, nonce };
    expect(parseActivation(url, 'wayroost-dev')).toEqual(activation);
    expect(activationFromArgv(['app.exe', '--wayroost-desktop-dev', url], 'wayroost-dev')).toEqual(activation);
    expect(parseActivation(url)).toBeNull();
    expect(parseActivation(url.replace('wayroost-dev:', 'wayroost:'), 'wayroost-dev')).toBeNull();
    const xml = toastXml('Agent', 'Needs you.', 'demo', nonce, { allowOnce: true, protocol: 'wayroost-dev' });
    expect(xml).toContain(`launch="wayroost-dev://approval/demo/open/${nonce}"`);
    expect(xml).toContain(`arguments="${url}"`);
    expect(xml).not.toContain('wayroost://');
  });
  it.each(['allow-once', 'open'])('accepts %s', (action) => {
    expect(parseActivation(`wayroost://approval/demo:ID_-/` + action)).toEqual({ id: 'demo:ID_-', action });
    expect(parseActivation(`wayroost://approval/demo:ID_-/${action}/${nonce}`)).toEqual({ id: 'demo:ID_-', action, nonce });
  });
  it.each([
    'https://approval/demo/open', 'file://approval/demo/open', 'wayroost://approval/demo/deny',
    'wayroost://approval/demo/open?x=1', 'wayroost://approval/demo/open#x', 'wayroost://approval/demo/open/',
    'wayroost://approval/demo/../open', 'wayroost://approval/%2e%2e/open', 'wayroost://approval/demo%2fother/open',
    'wayroost://approval/demo\\other/open', 'wayroost://user@approval/demo/open', 'wayroost://approval:80/demo/open',
    'WAYROOST://approval/demo/open', 'wayroost://approval//open', 'wayroost://approval/demo/open\n',
    `wayroost://approval/${'x'.repeat(201)}/open`, 'wayroost://approval/../open', 'wayroost://approval/.q0/open',
    'wayroost://approval/-demo/open', `wayroost://approval/demo/open/${nonce}x`, 'wayroost://approval/demo/allow-once/short',
    `wayroost://approval/demo/allow-once/${nonce}/`, `wayroost://approval/demo/allow-once/${nonce.slice(1)}=`, 'wayroost://approval/demo q0/open', 'wayroost://approval/demo%20q0/open',
  ])('refuses %s', (value) => expect(parseActivation(value)).toBeNull());
  it.each(['demo-req.q0', 'demo-req.choice_1', 'demo@host+1', `d${'x'.repeat(199)}`])('accepts the server id %s', (id) => {
    expect(parseActivation(`wayroost://approval/${id}/open`)).toEqual({ id, action: 'open' });
    expect(toastXml('Agent', 'Needs you.', id, nonce, { allowOnce: false })).toContain(`wayroost://approval/${id}/open/${nonce}`);
  });
  it('handles second-instance arguments and navigation policy', () => {
    expect(activationFromArgv(['app.exe', '--hidden', 'wayroost://approval/demo/open'])).toEqual({ id: 'demo', action: 'open' });
    expect(navigationKind('http://127.0.0.1:8896/c/demo', 'http://127.0.0.1:8896')).toBe('internal');
    expect(navigationKind('https://example.com', 'http://127.0.0.1:8896')).toBe('external');
    for (const url of ['javascript:alert(1)', 'file:///home/me', 'wayroost://approval/demo/open', 'https://user@example.com']) expect(navigationKind(url, 'http://127.0.0.1:8896')).toBe('refuse');
  });
});
describe('tray state', () => {
  it('maps health and approval count, giving down priority', () => {
    expect(trayState(status, 0).badge).toBe('');
    expect(trayState(status, 1).badge).toBe('!');
    expect(trayState({ ...status, overall: 'attention' }, 0).badge).toBe('!');
    expect(trayState({ ...status, overall: 'down' }, 3)).toEqual({ badge: '×', color: '#a8432f', sentence: status.sentence });
  });
  it('shows the app\'s own connection when the supervisor is not answering', () => {
    expect(healthStatus(undefined, 'connected', 1)).toEqual({ overall: 'ok', sentence: 'Wayroost is running.', components: [], at: 1 });
    expect(trayState(healthStatus(undefined, 'connected'), 0).badge).toBe('');
    expect(trayState(healthStatus(undefined, 'connected'), 2).badge).toBe('!');
    expect(healthStatus(undefined, 'reconnecting').overall).toBe('attention');
    expect(healthStatus(undefined, 'connecting').overall).toBe('attention');
    expect(healthStatus(undefined, 'down').overall).toBe('down');
  });
  it('lets the app make the supervisor status worse, never better', () => {
    const down: SupervisorStatus = { ...status, overall: 'down', sentence: 'Main model is stopped.' };
    expect(healthStatus(status, 'connected')).toBe(status);
    expect(healthStatus(down, 'connected')).toBe(down);
    expect(healthStatus(status, 'reconnecting')).toEqual({ ...status, overall: 'attention', sentence: 'Reconnecting to Wayroost.' });
    expect(healthStatus(down, 'reconnecting')).toBe(down);
    expect(healthStatus(status, 'down').overall).toBe('down');
  });
});
describe('rescue HTTP client', () => {
  let server: Server;
  let received: unknown;
  let rescueOrigin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer demo-rescue-key') { res.writeHead(401).end(); return; }
      if (req.method === 'GET' && req.url === '/v1/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status)); return; }
      if (req.method === 'POST' && req.url === '/v1/actions') {
        let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
          received = JSON.parse(body); res.setHeader('Content-Type', 'application/json'); res.end('{"actionId":"demo-action"}');
        }); return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { rescueOrigin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`; resolve(); }); });
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  it('reads status and uses the sole rescue action', async () => {
    const client = new RescueClient(rescueOrigin, async () => 'demo-rescue-key', { development: true });
    expect(await client.status()).toEqual(status);
    expect(await client.restart()).toEqual({ actionId: 'demo-action' });
    expect(received).toEqual({ verb: 'restart', target: 'wayroost-server', when: 'now' });
  });
  it('reports unauthorized without disclosing the key', async () => {
    const client = new RescueClient(rescueOrigin, async () => 'demo-invalid-key', { development: true });
    await expect(client.status()).rejects.toThrow(RescueUnauthorized);
    await expect(client.restart()).rejects.toThrow('Save a valid supervisor rescue key');
  });
  it('checks a rescue key with the supervisor before it is saved', async () => {
    expect(await checkRescueKey(rescueOrigin, 'demo-rescue-key', { development: true })).toEqual(status);
    await expect(checkRescueKey(rescueOrigin, 'demo-invalid-key', { development: true })).rejects.toThrow('refused that rescue key');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('obviously-fake-offline'));
    try { await expect(checkRescueKey(rescueOrigin, 'demo-rescue-key', { development: true })).rejects.toThrow('reach the supervisor'); }
    finally { fetch.mockRestore(); }
  });
  it('refuses remote rescue origins', () => expect(() => new RescueClient('https://example.com', async () => 'demo')).toThrow());
});
describe('toast tickets', () => {
  const approval: Approval = { id: 'demo-approval', source: 'hermes', conversationId: 'demo:chat', kind: 'permission', title: 'Run the demo check.', options: [{ id: 'once', label: 'Allow once', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], createdAt: 7 };
  const pending = (...items: Approval[]) => new Map(items.map((item) => [approvalKey(item), item]));
  it('allows once only with the unused ticket of the toast that showed the approval', () => {
    const tickets = new ToastTickets(); const issued = tickets.issue(approval);
    expect(issued).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parseActivation(`wayroost://approval/${approval.id}/allow-once/${issued}`)?.nonce).toBe(issued);
    const activation = { id: approval.id, action: 'allow-once' as const, nonce: issued };
    expect(resolveActivation(activation, pending(approval), tickets)).toEqual({ action: 'allow-once', approval });
    expect(resolveActivation(activation, pending(approval), tickets)).toEqual({ action: 'open', approval });
  });
  it('lets a toast allow only a once option with the whole detail on it', () => {
    expect(toastCanAllow(approval)).toBe(false);
    expect(toastCanAllow({ ...approval, detail: 'npm test' })).toBe(true);
    expect(toastCanAllow({ ...approval, detail: 'npm test\nrm -rf /home/me/demo' })).toBe(false);
    expect(toastCanAllow({ ...approval, detail: 'x'.repeat(TOAST_DETAIL_MAX + 1) })).toBe(false);
    expect(toastCanAllow({ ...approval, detail: 'pwd\u2028# harmless\u2028rm /tmp/demo' })).toBe(false);
    expect(toastCanAllow({ ...approval, detail: 'npm test', detailTruncated: true })).toBe(false);
    expect(toastCanAllow({ ...approval, options: [{ id: 'implement', label: 'Implement', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] })).toBe(false);
    // A Claude plan action that reuses Paseo's fallback ids is still not once.
    expect(toastCanAllow({ ...approval, source: 'paseo', detail: 'npm test', options: [{ id: 'allow', label: 'Implement (then auto-accepts edits)', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] })).toBe(false);
  });
  it('opens the conversation page with the approval named in the fragment', () => {
    expect(approvalUrl('http://127.0.0.1:8896', approval)).toBe('http://127.0.0.1:8896/c/hermes/demo%3Achat#approval-demo-approval');
    expect(approvalUrl('http://127.0.0.1:8896', { ...approval, source: 'paseo', id: 'demo-req.q0' })).toBe('http://127.0.0.1:8896/c/paseo/demo%3Achat#approval-demo-req.q0');
  });
  it('brings the main window forward only after the approval page loaded', async () => {
    const view = (load: () => Promise<unknown>) => ({ load: vi.fn(load), show: vi.fn(), reveal: vi.fn() });
    const loaded = view(async () => undefined);
    await openApprovalView('http://127.0.0.1:8896', approval, loaded);
    expect(loaded.load).toHaveBeenCalledWith(approvalUrl('http://127.0.0.1:8896', approval));
    expect(loaded.show).toHaveBeenCalledTimes(1); expect(loaded.reveal).not.toHaveBeenCalled();
    // The server is down: did-fail-load put the rescue page in front, and it stays there.
    const failed = view(async () => { throw new Error('ERR_CONNECTION_REFUSED (-102)'); });
    await openApprovalView('http://127.0.0.1:8896', approval, failed);
    expect(failed.show).not.toHaveBeenCalled(); expect(failed.reveal).toHaveBeenCalledTimes(1);
    const gone = view(async () => undefined);
    await openApprovalView('http://127.0.0.1:8896', undefined, gone);
    expect(gone.load).not.toHaveBeenCalled(); expect(gone.show).not.toHaveBeenCalled(); expect(gone.reveal).toHaveBeenCalledTimes(1);
  });
  it('brings the rescue page forward when someone activates a hidden start', async () => {
    // Started at sign-in with --hidden: a background failure stays in the tray, an activation doesn't.
    expect(rescueInFront({ hiddenStart: true, asked: false, windowVisible: false })).toBe(false);
    expect(rescueInFront({ hiddenStart: true, asked: true, windowVisible: false })).toBe(true);
    expect(rescueInFront({ hiddenStart: true, asked: false, windowVisible: true })).toBe(true);
    expect(rescueInFront({ hiddenStart: false, asked: false, windowVisible: false })).toBe(true);
    const steps = (refresh: () => Promise<void>) => ({ approvals: pending(approval), tickets: new ToastTickets(), refresh: vi.fn(refresh),
      allowOnce: vi.fn(async () => undefined), open: vi.fn(async () => undefined), reveal: vi.fn(), rescue: vi.fn(async () => undefined) });
    // The server is down when a toast is clicked: the rescue page, nothing else.
    const down = steps(async () => { throw new Error('ERR_CONNECTION_REFUSED (-102)'); });
    await runActivation({ id: approval.id, action: 'open', nonce }, down);
    expect(down.rescue).toHaveBeenCalledTimes(1); expect(down.open).not.toHaveBeenCalled(); expect(down.allowOnce).not.toHaveBeenCalled();
    // A bare start reveals; a working server opens the card or allows once with the toast's ticket.
    const up = steps(async () => undefined);
    await runActivation(null, up);
    expect(up.reveal).toHaveBeenCalledTimes(1); expect(up.refresh).not.toHaveBeenCalled();
    await runActivation({ id: approval.id, action: 'open' }, up);
    expect(up.open).toHaveBeenLastCalledWith(approval);
    await runActivation({ id: approval.id, action: 'allow-once', nonce: up.tickets.issue(approval) }, up);
    expect(up.allowOnce).toHaveBeenCalledWith(approval); expect(up.open).toHaveBeenCalledTimes(1);
    // Allow once refused: the full card instead.
    up.allowOnce.mockRejectedValueOnce(new Error('Open this approval to answer it.'));
    await runActivation({ id: approval.id, action: 'allow-once', nonce: up.tickets.issue(approval) }, up);
    expect(up.open).toHaveBeenCalledTimes(2); expect(up.rescue).not.toHaveBeenCalled();
  });
  it('does not open a cached approval if pairing is revoked while its answer is pending', async () => {
    const approvals = pending(approval); const tickets = new ToastTickets();
    const steps = { approvals, tickets, refresh: vi.fn(async () => undefined),
      allowOnce: vi.fn(async () => { approvals.clear(); throw new Error('Demo desktop revoked.'); }),
      open: vi.fn(async () => undefined), reveal: vi.fn(), rescue: vi.fn(async () => undefined) };
    await runActivation({ id: approval.id, action: 'allow-once', nonce: tickets.issue(approval) }, steps);
    expect(steps.open).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it('turns bare, unknown, mismatched and stale activations into open', () => {
    const tickets = new ToastTickets();
    expect(resolveActivation({ id: approval.id, action: 'allow-once' }, pending(approval), tickets)).toEqual({ action: 'open', approval });
    expect(resolveActivation({ id: approval.id, action: 'allow-once', nonce }, pending(approval), tickets).action).toBe('open');
    const forOther = tickets.issue({ ...approval, id: 'demo-other' });
    expect(resolveActivation({ id: approval.id, action: 'allow-once', nonce: forOther }, pending(approval), tickets).action).toBe('open');
    const reused = tickets.issue(approval);
    expect(resolveActivation({ id: approval.id, action: 'allow-once', nonce: reused }, pending({ ...approval, createdAt: 8 }), tickets).action).toBe('open');
    const forgotten = tickets.issue(approval); tickets.forget(approvalKey(approval));
    expect(resolveActivation({ id: approval.id, action: 'allow-once', nonce: forgotten }, pending(approval), tickets).action).toBe('open');
    expect(resolveActivation({ id: 'demo-missing', action: 'open' }, pending(approval), tickets)).toEqual({ action: 'open' });
  });
});
describe('app link', () => {
  it('keeps a failed page load down until a page loads, whatever the socket does', () => {
    const changed = vi.fn(); const appLink = new AppLink({ changed, retry: vi.fn() });
    expect(appLink.link).toBe('connecting');
    appLink.pageFailed(); expect(appLink.link).toBe('down');
    appLink.socketClosed(); expect(appLink.link).toBe('down');
    expect(trayState(healthStatus(undefined, appLink.link), 0).badge).toBe('×');
    appLink.socketOpened(); expect(appLink.link).toBe('down');
    appLink.pageLoaded(); expect(appLink.link).toBe('connected');
    appLink.socketClosed(); expect(appLink.link).toBe('reconnecting');
    appLink.pageLoaded(); expect(appLink.link).toBe('reconnecting');
    expect(changed).toHaveBeenCalledTimes(5);
  });
  it('retries the app page when the server answers again during recovery, and only then', () => {
    const retry = vi.fn(); const appLink = new AppLink({ changed: vi.fn(), retry });
    appLink.socketOpened(); appLink.answered(); expect(retry).not.toHaveBeenCalled();
    // A visible app loses its socket and the snapshot fails: the rescue page replaces the main window.
    appLink.socketClosed(); appLink.startRecovery(); expect(appLink.recovering).toBe(true);
    appLink.socketOpened(); expect(retry).toHaveBeenCalledTimes(1);
    appLink.answered(); expect(retry).toHaveBeenCalledTimes(2);
    // The page loaded and main.ts brought the main window back.
    appLink.pageLoaded(); appLink.endRecovery();
    appLink.answered(); appLink.socketOpened(); expect(retry).toHaveBeenCalledTimes(2);
  });
});
describe('app page', () => {
  /** An AppPage over a real AppLink, with the effects main.ts wires: rescue starts recovery, restore ends it. */
  const setup = () => {
    const appLink = new AppLink({ changed: vi.fn(), retry: vi.fn() });
    const effects = {
      load: vi.fn(), loaded: vi.fn(),
      rescue: vi.fn(() => { appLink.startRecovery(); }),
      restore: vi.fn(() => { appLink.endRecovery(); }),
    };
    return { appLink, effects, page: new AppPage(appLink, effects) };
  };
  it('keeps recovery and the reload going when the error document for a failed load fires dom-ready', () => {
    vi.useFakeTimers();
    try {
      const { appLink, effects, page } = setup();
      page.navigated(true); page.domReady();
      expect(effects.loaded).toHaveBeenCalledTimes(1);
      // The server goes away: the load fails and Chromium commits its error document for the same app URL.
      page.failed(-102); page.domReady();
      expect(appLink.link).toBe('down');
      expect(appLink.recovering).toBe(true);
      expect(effects.rescue).toHaveBeenCalledTimes(1);
      expect(effects.restore).not.toHaveBeenCalled();
      expect(effects.loaded).toHaveBeenCalledTimes(1);
      expect(page.reloading).toBe(true);
      vi.advanceTimersByTime(2000); expect(effects.load).toHaveBeenCalledTimes(1);
      // The reload fails too, with a longer back-off, and its error document is no more a page than the first.
      page.failed(-102); page.domReady();
      expect(effects.rescue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3999); expect(effects.load).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1); expect(effects.load).toHaveBeenCalledTimes(2);
      // The server is back: a real app page commits, and only that ends recovery and the reloads.
      page.navigated(true); page.domReady();
      expect(appLink.link).not.toBe('down');
      expect(appLink.recovering).toBe(false);
      expect(effects.restore).toHaveBeenCalledTimes(1);
      expect(page.reloading).toBe(false);
      vi.advanceTimersByTime(60000); expect(effects.load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('ignores dom-ready for a page off the app origin and a cancelled load', () => {
    const { appLink, effects, page } = setup();
    page.navigated(false); page.domReady();
    expect(effects.loaded).not.toHaveBeenCalled();
    page.navigated(true); page.failed(-3); page.domReady();
    expect(appLink.link).not.toBe('down');
    expect(effects.rescue).not.toHaveBeenCalled();
    expect(effects.loaded).toHaveBeenCalledTimes(1);
  });
  it('schedules no reload after quitting', () => {
    vi.useFakeTimers();
    try {
      const { effects, page } = setup();
      page.failed(-102); expect(page.reloading).toBe(true);
      page.stop(); expect(page.reloading).toBe(false);
      page.failed(-102); expect(page.reloading).toBe(false);
      vi.advanceTimersByTime(60000); expect(effects.load).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
describe('rescue presentation', () => {
  /** A promise settled from outside, standing in for the rescue page's first load. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  it('drops a rescue page that finishes loading after the app came back, and later failures still recover', async () => {
    const retry = vi.fn(); const appLink = new AppLink({ changed: vi.fn(), retry });
    const load = deferred<string>(); const present = vi.fn(); const instead = vi.fn();
    // The socket closed and the snapshot failed: recovery starts and the rescue page is still loading.
    const showing = presentRescue(appLink, () => load.promise, present);
    expect(appLink.recovering).toBe(true);
    // An authenticated snapshot lands, the app page reloads, and dom-ready ends recovery (the rescue page is hidden).
    appLink.answered(); expect(retry).toHaveBeenCalledTimes(1);
    const page = new AppPage(appLink, { load: vi.fn(), rescue: vi.fn(), loaded: vi.fn(), restore: () => appLink.endRecovery() });
    page.navigated(true); page.domReady();
    expect(appLink.recovering).toBe(false);
    load.resolve('rescue'); await showing;
    expect(present).not.toHaveBeenCalled();
    expect(appLink.recovering).toBe(false);
    // The next outage starts a fresh recovery, which shows its page, and a later answer retries the app again.
    await presentRescue(appLink, () => Promise.resolve('rescue'), present);
    expect(present).toHaveBeenCalledWith('rescue');
    appLink.answered(); expect(retry).toHaveBeenCalledTimes(2);
    // An asked-for rescue that turned stale brings the app forward instead.
    appLink.endRecovery();
    const asked = deferred<string>();
    const askedShowing = presentRescue(appLink, () => asked.promise, present, instead);
    appLink.endRecovery(); asked.resolve('rescue'); await askedShowing;
    expect(present).toHaveBeenCalledTimes(1);
    expect(instead).toHaveBeenCalledTimes(1);
  });
  it('shows the app that recovered before the rescue page loaded on a normal start, and keeps a hidden start hidden', async () => {
    /** The two windows and the effects main.ts wires, with the rescue page's first load held open. */
    const start = (hiddenStart: boolean) => {
      const shown = { main: false, rescue: false };
      const appLink = new AppLink({ changed: vi.fn(), retry: vi.fn() });
      const load = deferred<string>();
      const show = () => { appLink.endRecovery(); shown.rescue = false; shown.main = true; };
      const showRescue = () => presentRescue(appLink, () => load.promise, () => {
        if (rescueInFront({ hiddenStart, asked: false, windowVisible: shown.main })) { shown.main = false; shown.rescue = true; }
      });
      let rescuing: Promise<void> = Promise.resolve();
      const page = new AppPage(appLink, {
        load: vi.fn(), loaded: vi.fn(), rescue: () => { rescuing = showRescue(); },
        restore: () => {
          const rescueWouldFront = rescueInFront({ hiddenStart, asked: false, windowVisible: shown.main });
          if (restoreShowsApp({ rescueVisible: shown.rescue, rescuePresented: appLink.presented, rescueWouldFront })) show();
          else appLink.endRecovery();
        },
      });
      return { shown, appLink, load, page, rescuing: () => rescuing };
    };
    vi.useFakeTimers();
    try {
      // A normal start with a saved key: the first app load fails, so the main window was never shown.
      const normal = start(false);
      normal.page.failed(-102); expect(normal.appLink.recovering).toBe(true);
      // The server answers and the app page loads before the rescue page has finished its first load.
      normal.page.navigated(true); normal.page.domReady();
      expect(normal.shown).toEqual({ main: true, rescue: false });
      normal.load.resolve('rescue'); await normal.rescuing();
      expect(normal.shown).toEqual({ main: true, rescue: false });
      expect(normal.page.reloading).toBe(false);
      // Started with --hidden: the same race leaves both windows in the tray.
      const hidden = start(true);
      hidden.page.failed(-102); hidden.page.navigated(true); hidden.page.domReady();
      hidden.load.resolve('rescue'); await hidden.rescuing();
      expect(hidden.shown).toEqual({ main: false, rescue: false });
      expect(hidden.appLink.recovering).toBe(false);
      // A rescue page that was put up and then closed to the tray leaves the recovered app in the tray too.
      const closed = start(false);
      closed.load.resolve('rescue');
      closed.page.failed(-102); await closed.rescuing();
      expect(closed.shown).toEqual({ main: false, rescue: true });
      closed.shown.rescue = false;
      closed.page.navigated(true); closed.page.domReady();
      expect(closed.shown).toEqual({ main: false, rescue: false });
      expect(closed.appLink.recovering).toBe(false);
    } finally { vi.useRealTimers(); }
    expect(restoreShowsApp({ rescueVisible: true, rescuePresented: true, rescueWouldFront: false })).toBe(true);
    expect(restoreShowsApp({ rescueVisible: false, rescuePresented: false, rescueWouldFront: true })).toBe(true);
    expect(restoreShowsApp({ rescueVisible: false, rescuePresented: true, rescueWouldFront: true })).toBe(false);
    expect(restoreShowsApp({ rescueVisible: false, rescuePresented: false, rescueWouldFront: false })).toBe(false);
  });
  it('lets a second rescue during the same recovery present too', async () => {
    const appLink = new AppLink({ changed: vi.fn(), retry: vi.fn() });
    const load = deferred<string>(); const present = vi.fn();
    const first = presentRescue(appLink, () => load.promise, present);
    const second = presentRescue(appLink, () => load.promise, present);
    load.resolve('rescue'); await Promise.all([first, second]);
    expect(present).toHaveBeenCalledTimes(2);
  });
  it('makes the rescue window once for callers that arrive during its first load, and again after a failure', async () => {
    const loads = [deferred<object>(), deferred<object>()];
    let made = 0;
    const create = vi.fn(() => loads[made++]!.promise);
    const window = shared(create);
    const a = window(); const b = window();
    expect(create).toHaveBeenCalledTimes(1);
    loads[0]!.reject(new Error('load failed'));
    await expect(a).rejects.toThrow('load failed'); await expect(b).rejects.toThrow('load failed');
    const c = window(); const d = window();
    expect(create).toHaveBeenCalledTimes(2);
    const page = {}; loads[1]!.resolve(page);
    expect(await c).toBe(page); expect(await d).toBe(page); expect(await window()).toBe(page);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

it('shows the shadow attachment in desktop status while preserving supervisor failures', () => {
  expect(healthStatus(undefined, 'connected', 1, true).sentence).toContain('attached to a shadow');
  const status = { overall: 'down' as const, sentence: 'Demo component is down.', components: [], at: 1 };
  expect(healthStatus(status, 'connected', 1, true)).toMatchObject({ overall: 'down' });
  expect(healthStatus(status, 'connected', 1, true).sentence).toContain('shadow');
});
