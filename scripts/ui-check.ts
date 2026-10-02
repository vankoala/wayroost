// Visual + behavioural check: runs the real server (full security stack) with
// demo sources, drives headless Chrome at phone and desktop sizes, saves
// screenshots, and fails on any page error or CSP violation.
//   npm run build:web && npx tsx scripts/ui-check.ts <output-dir>
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { buildApp } from '../server/src/app.js';
import { parseConfig } from '../server/src/config.js';
import { EventHub } from '../server/src/hub.js';
import { createAccessVerifier } from '../server/src/security/access.js';
import { demoAssist, demoConnectors, demoDashboard, demoHelper, demoPaseoSchedules } from './demo-connectors.js';
import { Schedules } from '../server/src/schedules.js';
import { demoSkills } from './demo-skills.js';
import { DEMO_TRANSCRIPT, DemoSpeech } from './demo-speech.js';
import { demoFeed } from './demo-feed.js';
import { DemoHermes, DemoPaseo, startDemoBridge } from './demo-sources.js';
import { createLocalAccess, startEdge } from './lib/local-access.js';

const OUT = resolve(process.argv[2] ?? 'ui-shots');
// The browser talks to a stand-in for Cloudflare's edge on PORT, which stamps
// the Access JWT on every request and WebSocket handshake, like the real one.
const PORT = Number(process.env.PORT ?? 8795);
const APP_PORT = PORT + 1;
const ORIGIN = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });
const access = await createLocalAccess({ issuer: 'http://127.0.0.1:1' });
const config = parseConfig(
  {
    listen: { host: '127.0.0.1', port: APP_PORT },
    publicOrigin: ORIGIN,
    access: { teamDomain: access.issuer, aud: access.aud, allowedEmails: [access.email] },
    stateDir: mkdtempSync(join(tmpdir(), 'sb-ui-')),
    staticDir: resolve('dist/web'),
  },
  { allowLocalDev: true },
);
const hub = new EventHub();
const sources = { hermes: new DemoHermes(hub), paseo: new DemoPaseo(hub) };
const bridge = await startDemoBridge(sources, hub);
const speech = new DemoSpeech();
const feed = demoFeed(hub, sources.hermes, mkdtempSync(join(tmpdir(), 'sb-ui-feed-')));
feed.start();
const app = await buildApp({
  config,
  verifier: createAccessVerifier({ ...config.access, keySource: access.keySource }),
  hub,
  sources,
  feed,
  bridge,
  connectors: demoConnectors(ORIGIN),
  schedules: new Schedules({
    dashboard: () => demoDashboard,
    paseo: demoPaseoSchedules,
    assist: demoAssist,
    onChanged: () => hub.publish({ type: 'schedules_changed' }),
    log: { info() {}, warn() {} },
  }),
  whatsappRouting: demoHelper,
  phone: demoHelper,
  skills: demoSkills,
  speech,
  logger: false,
});
await app.listen({ host: '127.0.0.1', port: APP_PORT });
const edge = await startEdge({ port: PORT, appPort: APP_PORT, token: access.token });

// Voice mode: Chrome's fake microphone (a beeping tone) stands in for a real one.
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const problems: string[] = [];

/** Everything a page received, for checking that a secret never came back. */
interface Seen {
  responses: Array<Promise<string>>;
  frames: string[];
  console: string[];
  posts: string[];
}

async function shoot(
  name: string,
  opts: {
    width: number;
    height: number;
    dark: boolean;
    path: string;
    ready: string;
    act?: (page: Page, seen: Seen) => Promise<void>;
    /** More steps after the screenshot. */
    after?: (page: Page, seen: Seen) => Promise<void>;
    /** Console errors this shot causes on purpose (e.g. a failed request it forces). */
    expectErrors?: RegExp;
  },
) {
  const phone = opts.width < 600;
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2,
    colorScheme: opts.dark ? 'dark' : 'light',
    isMobile: phone,
    hasTouch: phone,
    permissions: ['microphone', 'notifications'],
  });
  const page = await context.newPage();
  const seen: Seen = { responses: [], frames: [], console: [], posts: [] };
  page.on('console', (m) => {
    seen.console.push(m.text());
    if (m.type() === 'error' && !opts.expectErrors?.test(m.text())) problems.push(`${name}: console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${name}: pageerror: ${e.message}`));
  page.on('response', (res) => seen.responses.push(res.text().catch(() => '')));
  page.on('request', (req) => {
    if (req.method() === 'POST') seen.posts.push(req.postData() ?? '');
  });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => seen.frames.push(String(f.payload))));
  await page.goto(ORIGIN + opts.path);
  await page.waitForSelector(opts.ready, { timeout: 10_000 });
  await opts.act?.(page, seen);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('shot', name);
  await opts.after?.(page, seen);
  await context.close();
}

const phone = { width: 393, height: 852 };
try {
  await shoot('01-phone-inbox-dark', { ...phone, dark: true, path: '/', ready: '.row' });
  await shoot('02-phone-inbox-light', { ...phone, dark: false, path: '/', ready: '.row' });
  await shoot('03-phone-approval', { ...phone, dark: true, path: '/c/hermes/20260927_071000_a1b2c3', ready: '.approval-dock .approval' });
  await shoot('04-phone-agent', {
    ...phone,
    dark: true,
    path: '/c/paseo/5f0c2a8e-login',
    ready: '.msg-assistant',
    act: async (page) => {
      await page.locator('.tool summary').nth(1).click();
    },
  });
  await shoot('05-phone-new-paseo', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('.fab');
      await page.click('.segmented button:nth-child(2)');
      await page.waitForSelector('.option');
    },
  });
  await shoot('06-phone-settings', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      await page.waitForSelector('.sheet');
    },
  });
  await shoot('07-phone-send-and-stream', {
    ...phone,
    dark: true,
    path: '/c/paseo/9a7d1c33-billing',
    ready: '.msg-user',
    act: async (page) => {
      await page.fill('.composer textarea', 'Also add a changelog entry.');
      await page.click('button[aria-label="Send"]');
      await page.waitForSelector('.msg-assistant', { timeout: 5000 });
      await page.waitForTimeout(3500);
      const text = await page.locator('.msg-assistant').last().innerText();
      if (!text.includes('attention')) problems.push(`stream did not complete: "${text}"`);
    },
  });
  await shoot('08-desktop', { width: 1280, height: 820, dark: true, path: '/c/paseo/5f0c2a8e-login', ready: '.msg-assistant' });
  await shoot('11-phone-projects', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('.view-toggle button:has-text("Projects")');
      await page.waitForSelector('.project');
      const webapp = page.locator('.project', { hasText: 'webapp' });
      if ((await webapp.locator('.lane-hermes .row').count()) !== 1) problems.push('hermes chat in project folder not grouped');
      // Everything the login agent started sits under it, the Hermes chat it started through the bridge too.
      const login = webapp.locator('.lane-paseo .thread', { hasText: 'Fix flaky login test' });
      const under = (await login.locator('.thread-children .row-title').allInnerTexts()).sort();
      if (under.join() !== 'Collect CI logs,Dig through flaky-test history,Release notes: session fixes') problems.push(`login thread: ${under.join()}`);
      // Started through the real bridge by the billing agent (Paseo → Hermes): nested under it.
      const billing = page.locator('.project', { hasText: 'billing' });
      if (!(await billing.locator('.lane-paseo .thread-children .row', { hasText: 'Slowest invoice tests' }).count())) {
        problems.push('bridge-started chat not under its starter');
      }
      if ((await webapp.locator('.tag-linked').count()) < 1) problems.push('Hermes-in-Paseo tag missing');
    },
  });
  await shoot('12-phone-linked-thread', {
    ...phone,
    dark: true,
    path: '/c/paseo/e1f2a3b4-history',
    ready: '.links-bar',
    act: async (page) => {
      const bar = await page.locator('.links-bar').innerText();
      if (!bar.includes('Fix flaky login test') || !bar.includes('Collect CI logs')) problems.push(`links bar: ${bar}`);
    },
  });
  await shoot('09-phone-hidden-payload', {
    ...phone,
    dark: true,
    path: '/c/paseo/7c1e0b55-deps',
    ready: '.approval-dock .approval',
    act: async (page) => {
      const text = await page.locator('.approval pre').innerText();
      if (!text.includes('curl') || !text.includes('blank lines') || !text.includes('U+202E')) {
        problems.push(`hidden payload not revealed: ${JSON.stringify(text)}`);
      }
      // Freshly shown cards ignore taps briefly (a tap meant for the previous card).
      if (!(await page.locator('.approval .btn-approve').isDisabled())) problems.push('allow armed immediately');
      await page.waitForTimeout(900);
      if (await page.locator('.approval .btn-approve').isDisabled()) problems.push('allow never armed');
    },
  });
  await shoot('10-phone-new-pi', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('.fab');
      await page.click('.segmented button:nth-child(2)');
      await page.waitForSelector('.chip[role="radio"]');
      await page.click('.chip[role="radio"]:has-text("Pi")');
      await page.fill('.sheet textarea', 'Tidy up the README');
      if (!(await page.locator('.sheet-foot .btn-primary').isDisabled())) problems.push('launch allowed without consent');
      await page.click('.ack');
      if (await page.locator('.sheet-foot .btn-primary').isDisabled()) problems.push('launch still blocked after consent');
    },
  });

  // ---- "/" commands and attachments ----
  const digest = '/c/hermes/20260926_180000_d4e5f6';
  const photo = { name: 'signal.png', mimeType: 'image/png', buffer: readFileSync('web/public/icons/icon-192.png') };
  const notes = { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n- the agenda\n') };
  const box = (page: Page) => page.locator('.composer textarea');
  const menuRows = (page: Page, scope = '.composer') => page.locator(`${scope} [role="option"]`).allInnerTexts();
  // Polls from here: the page's CSP (rightly) refuses the eval behind waitForFunction.
  const until = async (what: string, check: () => Promise<boolean>, timeoutMs = 5000) => {
    for (const end = Date.now() + timeoutMs; !(await check()); ) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };

  await shoot('13-phone-slash-menu', {
    ...phone,
    dark: true,
    path: digest,
    ready: '.msg-assistant',
    act: async (page) => {
      await box(page).fill('/');
      await page.waitForSelector('.composer [role="listbox"]');
      const groups = (await page.locator('.composer .slash-group').allInnerTexts()).map((g) => g.toLowerCase());
      if (groups.join() !== 'session,configuration,skills') problems.push(`slash groups: ${groups.join()}`);
      if ((await box(page).getAttribute('aria-expanded')) !== 'true') problems.push('combobox not expanded');
      const first = await page.locator('.composer [role="option"]').first().getAttribute('id');
      if (!first || (await box(page).getAttribute('aria-activedescendant')) !== first) problems.push('first row not active');
      await box(page).press('ArrowDown');
      const second = await page.locator('.composer [role="option"]').nth(1).getAttribute('id');
      if ((await box(page).getAttribute('aria-activedescendant')) !== second) problems.push('ArrowDown did not move');
      await box(page).press('Escape');
      if (await page.locator('.composer [role="listbox"]').count()) problems.push('Escape did not close the menu');

      await box(page).fill('/comp');
      const rows = await menuRows(page);
      if (rows.length !== 1 || !rows[0]!.includes('/compress')) problems.push(`"/comp" rows: ${JSON.stringify(rows)}`);
      await box(page).press('Tab');
      if ((await box(page).inputValue()) !== '/compress ') problems.push(`Tab gave "${await box(page).inputValue()}"`);
      if (await page.locator('.composer [role="listbox"]').count()) problems.push('menu open after picking /compress');

      await box(page).fill('');
      await box(page).fill('/');
      await page.waitForSelector('.composer [role="listbox"]');
    },
  });

  await shoot('14-phone-slash-options', {
    ...phone,
    dark: false,
    path: digest,
    ready: '.msg-assistant',
    act: async (page) => {
      await box(page).fill('/reasoning h');
      await page.waitForSelector('.composer [role="listbox"]');
      const values = await menuRows(page);
      if (values.join() !== 'high,xhigh') problems.push(`"/reasoning h" values: ${values.join()}`);
      await box(page).press('Enter');
      if ((await box(page).inputValue()) !== '/reasoning high') problems.push(`Enter gave "${await box(page).inputValue()}"`);
      if (await page.locator('.composer [role="listbox"]').count()) problems.push('menu open after picking a value');

      await box(page).fill('/reasoning ');
      await page.waitForSelector('.composer [role="listbox"]');
      if ((await menuRows(page)).length !== 7) problems.push('"/reasoning " did not list its levels');
    },
  });

  await shoot('15-phone-command-output', {
    ...phone,
    dark: true,
    path: digest,
    ready: '.msg-assistant',
    act: async (page) => {
      const bubbles = await page.locator('.msg-user').count();
      await box(page).fill('/stop');
      await page.click('button[aria-label="Send"]');
      await until('the box to clear', async () => (await box(page).inputValue()) === '');
      await page.waitForTimeout(500);
      if ((await page.locator('.cmd').count()) !== 0) problems.push('/stop was sent instead of handled here');

      await box(page).fill('/status');
      await page.click('button[aria-label="Send"]');
      await page.waitForSelector('.cmd:not(.running) .cmd-out');
      const status = await page.locator('.cmd .cmd-out').first().innerText();
      if (!status.includes('claude-sonnet-5') || /\x1b|\[1m/.test(status)) problems.push(`status output: ${JSON.stringify(status)}`);
      if ((await page.locator('.cmd-head code').first().innerText()) !== '/status') problems.push('command header');

      await box(page).fill('/help');
      await page.click('button[aria-label="Send"]');
      await page.locator('.cmd .cmd-out').nth(1).waitFor();
      const more = page.locator('.cmd-more');
      if (!(await more.innerText()).startsWith('Show all')) problems.push('long output not clamped');
      const clamped = (await page.locator('.cmd .cmd-out').nth(1).innerText()).split('\n').length;
      await more.click();
      const full = (await page.locator('.cmd .cmd-out').nth(1).innerText()).split('\n').length;
      if (clamped !== 12 || full <= clamped) problems.push(`clamp: ${clamped} → ${full} lines`);
      await more.click();
      if ((await page.locator('.msg-user').count()) !== bubbles) problems.push('a command showed up as a message');
    },
  });

  await shoot('16-phone-attachments', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260927_080000_abcdef',
    ready: '.msg-files',
    act: async (page) => {
      const seeded = await page.locator('.msg-user').first().locator('.msg-file').allInnerTexts();
      if (seeded.join() !== 'session-expired.png,auth.log,refresh-spec.pdf') problems.push(`seeded chips: ${seeded.join()}`);
      if ((await page.locator('.cmd.error').count()) !== 1) problems.push('error command not styled');
      await page.setInputFiles('.composer input[type=file]', [photo, notes]);
      await page.locator('.composer .attach-chip').nth(1).waitFor();
      await box(page).fill('Same error again, screenshot attached');
      await page.click('button[aria-label="Send"]');
      // The server's copy of the message keeps this browser's thumbnail.
      await page.waitForSelector('.msg-user:not(.pending) img.msg-file-thumb');
      const src = await page.locator('.msg-user:not(.pending) img.msg-file-thumb').getAttribute('src');
      if (!src?.startsWith('blob:')) problems.push(`thumbnail src: ${src}`);
      const sent = await page.locator('.msg-user').last().locator('.msg-file').allInnerTexts();
      if (sent.join() !== 'signal.png,notes.md') problems.push(`sent chips: ${sent.join()}`);
      if (await page.locator('.composer .attach-chip').count()) problems.push('chips left in the composer');
      await page.waitForTimeout(2800);
    },
  });

  await shoot('17-phone-new-from-slash', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260927_080000_abcdef',
    ready: '.msg-files',
    act: async (page) => {
      await box(page).fill('/new Plan a reading list for the winter');
      await page.click('button[aria-label="Send"]');
      await page.waitForSelector('.sheet');
      if ((await page.locator('.sheet textarea').inputValue()) !== 'Plan a reading list for the winter') problems.push('/new lost its text');
      if ((await page.locator('.segmented [aria-selected="true"]').innerText()).trim() !== 'Hermes') problems.push('/new opened the wrong tab');
      const folder = await page.locator('input[aria-label="Folder for this Hermes chat"]').inputValue();
      if (folder !== '/home/me/code/webapp/src') problems.push(`/new folder: "${folder}"`);
      if (!(await page.locator('.sheet .attach-btn').isVisible())) problems.push('no paperclip in the new sheet');
      await page.setInputFiles('.sheet input[type=file]', [photo]);
      await page.waitForSelector('.sheet .attach-chip');
      await page.locator('.sheet textarea').fill('/re');
      await page.waitForSelector('.sheet [role="listbox"]');
      const rows = await menuRows(page, '.sheet');
      if (!rows.some((r) => r.includes('/reasoning')) || rows.some((r) => r.startsWith('/new'))) problems.push(`sheet rows: ${rows.join(' | ')}`);
      await page.locator('.sheet textarea').press('Escape');
      if (!(await page.locator('.sheet').isVisible())) problems.push('Escape in the menu closed the sheet');
      if (await page.locator('.sheet [role="listbox"]').count()) problems.push('Escape did not close the sheet menu');
      await page.locator('.sheet textarea').fill('');
      await page.locator('.sheet textarea').fill('/re');
      await page.waitForSelector('.sheet [role="listbox"]');
    },
  });

  await shoot('18-phone-new-with-photo', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      // A photo and no text starts a chat; its thumbnail follows into the new conversation.
      await page.click('.fab');
      await page.setInputFiles('.sheet input[type=file]', [photo]);
      await page.waitForSelector('.sheet .attach-chip');
      await page.click('.sheet-foot .btn-primary');
      await page.waitForSelector('.msg-user img.msg-file-thumb');
      if (!(await page.locator('.msg-user').first().getAttribute('class'))?.includes('files-only')) problems.push('photo-only bubble');

      // A "/" command as the first message shows its output instead of a message.
      await page.click('button[aria-label="Back"]');
      await page.click('.fab');
      await page.locator('.sheet textarea').fill('/status');
      await page.locator('.sheet textarea').press('Escape');
      await page.click('.sheet-foot .btn-primary');
      await page.waitForSelector('.cmd .cmd-out');
      if (await page.locator('.msg-user').count()) problems.push('first-message command showed as a message');
      // Still there after leaving and coming back.
      await page.click('button[aria-label="Back"]');
      await page.click('.row:has-text("Photo")');
      await page.waitForSelector('.msg-user img.msg-file-thumb');
      await page.waitForSelector('.msg-assistant:not(.streaming)', { timeout: 6000 });
    },
  });

  await shoot('19-phone-compress-moves', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260926_090000_778899',
    ready: '.msg-user',
    act: async (page) => {
      // /undo hands the last message back to edit.
      await box(page).fill('/undo');
      await page.click('button[aria-label="Send"]');
      await until('the /undo prefill', async () => (await box(page).inputValue()) === 'Help me plan the team offsite.');
      if (await page.locator('.msg-user').count()) problems.push('/undo left the message in place');

      // /compress runs for a while, then Hermes continues in a new session.
      const historyLength = await page.evaluate('history.length');
      await box(page).fill('/compress');
      await page.click('button[aria-label="Send"]');
      await page.waitForSelector('.cmd.running');
      if (!(await page.locator('.cmd.running').innerText()).includes('Running /compress')) problems.push('no running row');
      await box(page).fill('Next: the agenda');
      await page.waitForURL((url) => url.pathname.startsWith('/c/hermes/') && !url.pathname.endsWith('20260926_090000_778899'));
      await page.waitForSelector('.cmd:not(.running) .cmd-out');
      if (!(await page.locator('.cmd .cmd-out').last().innerText()).includes('Compressed 14 messages')) problems.push('compress output');
      if ((await box(page).inputValue()) !== 'Next: the agenda') problems.push('draft did not follow the move');
      if ((await page.evaluate('history.length')) !== historyLength) problems.push('move added a history entry');
      if (await page.locator('.cmd.running').count()) problems.push('running row left behind');
    },
  });

  // With the phone keyboard up the app is only as tall as what's left visible.
  await shoot('20-phone-slash-keyboard', {
    width: 393,
    height: 520,
    dark: false,
    path: '/c/hermes/20260927_080000_abcdef',
    ready: '.cmd',
    act: async (page) => {
      await box(page).fill('/s');
      await page.waitForSelector('.composer [role="listbox"]');
      await page.waitForTimeout(300); // let it finish rising into place
      const menu = await page.locator('.composer .slash-menu').boundingBox();
      const input = await page.locator('.composer-box').boundingBox();
      const header = await page.locator('.pane-conv .topbar').boundingBox();
      if (!menu || !input || !header) problems.push('slash menu layout');
      else if (menu.y + menu.height > input.y || menu.y < header.y + header.height || menu.height > 520 * 0.46) {
        problems.push(`slash menu doesn't fit above the box: ${JSON.stringify({ menu, input })}`);
      }
    },
  });

  // ---- Conversation controls ----
  const chip = (page: Page, label: string) => page.locator(`.control-chip[aria-label^="${label}:"]`);
  const option = (page: Page, label: string) => page.locator(`.sheet [role="radio"]:has(.pick-label:text-is("${label}"))`);
  const sheetGone = (page: Page) => page.waitForSelector('.sheet', { state: 'detached' });

  await shoot('22-phone-controls-strip', {
    ...phone,
    dark: true,
    path: '/c/paseo/5f0c2a8e-login',
    ready: '.controls-strip',
    act: async (page) => {
      // While the agent works its model can't change, and the chip says why.
      const model = chip(page, 'Model');
      if ((await model.getAttribute('aria-disabled')) !== 'true') problems.push('model chip enabled while working');
      await model.click({ force: true }); // a tap still lands on an aria-disabled chip
      await page.waitForSelector('.toast:has-text("once the agent stops working")');
      if (await page.locator('.sheet').count()) problems.push('disabled chip opened a picker');

      await page.goto(`${ORIGIN}/c/hermes/20260927_080000_abcdef`);
      await page.waitForSelector('.controls-strip');
      const chips = page.locator('.control-chip');
      const labels = [];
      for (let i = 0; i < (await chips.count()); i++) labels.push(await chips.nth(i).getAttribute('aria-label'));
      if (labels.join() !== 'Model: claude-sonnet-5,Reasoning: Medium') problems.push(`chips: ${labels.join()}`);
      if ((await chips.first().getAttribute('aria-haspopup')) !== 'dialog') problems.push('chip lacks aria-haspopup');
      const ring = page.locator('.context-ring');
      const before = await ring.getAttribute('aria-label');
      if (!before?.startsWith('Context: 2')) problems.push(`ring: ${before}`);
      // A finished turn refreshes the ring (each demo reply uses 1.3k tokens).
      await box(page).fill('Thanks. Where is the retry configured?');
      await page.click('button[aria-label="Send"]');
      // After a ~2.5 s streamed reply and a refetch: allow for a busy machine.
      await until('the ring to update after the reply', async () => (await ring.getAttribute('aria-label')) !== before, 15_000);
      await ring.click();
      const toastText = await page.locator('.toast').last().innerText();
      if (!/^\d+(\.\d)?k of 200k tokens \(\d+%\)$/.test(toastText)) problems.push(`context toast: ${toastText}`);
    },
  });

  await shoot('23-phone-model-picker', {
    ...phone,
    dark: false,
    path: '/c/hermes/20260927_071000_a1b2c3',
    ready: '.controls-strip',
    act: async (page) => {
      await chip(page, 'Model').click();
      await page.waitForSelector('.sheet[role="dialog"]');
      const groups = (await page.locator('.sheet .pick-group-label').allInnerTexts()).map((g) => g.toLowerCase());
      if (groups.join() !== 'anthropic,openai') problems.push(`picker groups: ${groups.join()}`);
      const current = await page.locator('.sheet [role="radio"][aria-checked="true"]').innerText();
      if (!current.startsWith('claude-sonnet-5') || !current.includes('$3 in · $15 out')) problems.push(`current: ${current}`);
      const filter = page.locator('.sheet input[type="search"]');
      await filter.fill('mini');
      const found = await page.locator('.sheet .pick-label').allInnerTexts();
      if (found.join() !== 'gpt-5-mini,o4-mini') problems.push(`filtered: ${found.join()}`);
      await filter.fill('');
      // Waiting on an approval is mid-turn: the switch applies from the next turn.
      await option(page, 'gpt-5').click();
      await sheetGone(page);
      await page.waitForSelector('.toast:has-text("Takes effect on the next turn.")');
      if ((await chip(page, 'Model').getAttribute('aria-label')) !== 'Model: gpt-5') problems.push('model chip not updated');
      if ((await page.locator('.context-ring').innerText()).trim() !== '38%') problems.push('ring ignores the new window');
      await chip(page, 'Model').click();
      await page.waitForSelector('.sheet [role="radio"][aria-checked="true"]');
    },
  });

  await shoot('24-phone-mode-consent', {
    ...phone,
    dark: true,
    path: '/c/paseo/9a7d1c33-billing',
    ready: '.controls-strip',
    act: async (page) => {
      const mode = chip(page, 'Mode');
      if ((await mode.getAttribute('aria-label')) !== 'Mode: Always Ask') problems.push('mode chip');
      await chip(page, 'Model').click();
      await page.keyboard.press('Escape');
      await sheetGone(page);

      await mode.click();
      await option(page, 'Accept File Edits').click();
      await page.waitForSelector('.sheet .ack');
      const use = page.locator('.sheet-foot .btn-primary');
      if (!(await use.isDisabled())) problems.push('auto-approving mode offered without consent');
      await page.click('.sheet-foot .btn-secondary');
      await option(page, 'Accept File Edits').click();
      await page.click('.sheet .ack');
      await use.click();
      await sheetGone(page);
      if ((await mode.getAttribute('aria-label')) !== 'Mode: Accept File Edits') problems.push('mode not switched');
      if (!(await mode.getAttribute('class'))?.includes('auto')) problems.push('auto-approving mode not marked');

      // Going back to asking first needs no consent.
      await mode.click();
      await option(page, 'Always Ask').click();
      await sheetGone(page);
      await mode.click();
      await option(page, 'Accept File Edits').click();
      await page.waitForSelector('.sheet .ack');
    },
  });

  await shoot('25-phone-expensive-confirm', {
    ...phone,
    dark: false,
    path: '/c/hermes/20260926_180000_d4e5f6',
    ready: '.controls-strip',
    act: async (page) => {
      const model = chip(page, 'Model');
      await model.click();
      await option(page, 'claude-opus-5').click();
      const dialog = page.locator('[role="alertdialog"]');
      await dialog.waitFor();
      if (!(await dialog.locator('p').innerText()).includes('$15 in · $75 out')) problems.push('confirm text');
      // No (and Escape) change nothing and leave the picker open.
      await dialog.locator('.btn-secondary').click();
      await dialog.waitFor({ state: 'detached' });
      await option(page, 'claude-opus-5').click();
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      if (!(await page.locator('.sheet').isVisible())) problems.push('Escape closed the picker too');
      if ((await model.getAttribute('aria-label')) !== 'Model: claude-sonnet-5') problems.push('switched without a yes');
      // Yes resends with confirm.
      await option(page, 'claude-opus-5').click();
      await dialog.locator('.btn-primary').click();
      await sheetGone(page);
      if ((await model.getAttribute('aria-label')) !== 'Model: claude-opus-5') problems.push('confirmed switch not applied');

      await model.click();
      await option(page, 'claude-sonnet-5').click();
      await sheetGone(page);
      await model.click();
      await option(page, 'claude-opus-5').click();
      await dialog.waitFor();
    },
  });

  // ---- Images from the user's machine ----
  const report = '/c/hermes/20260927_064500_5e6f7a';
  const blobSrc = async (page: Page, selector: string) => (await page.locator(selector).first().getAttribute('src')) ?? '';

  await shoot('26-phone-inline-image', {
    ...phone,
    dark: true,
    path: report,
    ready: '.md-media.ready img',
    act: async (page) => {
      const image = page.locator('.md-media.ready img');
      if (!(await blobSrc(page, '.md-media.ready img')).startsWith('blob:')) problems.push('inline image not a blob');
      if ((await image.getAttribute('alt')) !== 'p95 latency, last 7 days') problems.push('inline image alt text');
      if ((await image.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)) !== 640) {
        problems.push('inline image did not decode');
      }
      // The path the agent wrote never becomes a link.
      if (await page.locator('.msg-assistant a[href*="/home/"], .msg-assistant a[href*="/api/media"]').count()) {
        problems.push('a local path became a link');
      }
      // A path mentioned in passing shows as a thumbnail under the reply.
      await page.waitForSelector('.media-strip .media-thumb img');
      if (!(await blobSrc(page, '.media-strip .media-thumb img')).startsWith('blob:')) problems.push('strip thumbnail not a blob');
    },
  });

  await shoot('27-phone-image-viewer', {
    ...phone,
    dark: true,
    path: report,
    ready: '.md-media.ready img',
    act: async (page) => {
      const viewer = page.locator('.viewer');
      await page.click('.md-media.ready');
      await viewer.waitFor();
      if (!(await blobSrc(page, '.viewer-image')).startsWith('blob:')) problems.push('viewer image not a blob');
      const open = page.locator('.viewer-action');
      if (!(await open.getAttribute('href'))?.startsWith('blob:') || (await open.getAttribute('target')) !== '_blank') {
        problems.push('viewer Open action');
      }
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'detached' });
      // A tap beside the picture closes it too.
      await page.click('.md-media.ready');
      await viewer.waitFor();
      await page.mouse.click(20, phone.height - 40);
      await viewer.waitFor({ state: 'detached' });
      await page.click('.media-strip .media-thumb');
      await viewer.waitFor();
      if ((await page.locator('.viewer-name').innerText()) !== 'signalbox-icon.png') problems.push('viewer name');
    },
  });

  await shoot('28-phone-tool-image', {
    ...phone,
    dark: false,
    path: '/c/paseo/e1f2a3b4-history',
    ready: '.tool-media .media-thumb img',
    act: async (page) => {
      // Shown while the tool card is still closed.
      if (await page.locator('details.tool.has-media[open]').count()) problems.push('tool card opened by itself');
      if (!(await blobSrc(page, '.tool-media .media-thumb img')).startsWith('blob:')) problems.push('tool thumbnail not a blob');
      await page.click('.tool-media .media-thumb');
      await page.locator('.viewer').waitFor();
      if ((await page.locator('.viewer-name').innerText()) !== 'login-failure.png') problems.push('tool image name');
      await page.click('.viewer-close');
      await page.locator('.viewer').waitFor({ state: 'detached' });
    },
  });

  // ---- Project bridge ----
  await shoot('29-phone-bridged-message', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      // The inbox never shows the envelope, and says who started the chat.
      if ((await page.locator('.list').innerText()).includes('[Message from')) problems.push('envelope in the inbox');
      const row = page.locator('.row', { hasText: 'Release notes: session fixes' });
      if (!(await row.innerText()).includes('started by Fix flaky login test')) problems.push('started-by line in recent');
      await row.click();
      const bubble = page.locator('.msg-bridged').first();
      await bubble.waitFor();
      // The chat it started, and the follow-up it sent through the bridge.
      if ((await page.locator('.msg-bridged').count()) !== 2) problems.push('bridged follow-up missing');
      const head = await bubble.locator('.bridged-head').innerText();
      if (head !== 'From Fix flaky login test (Claude Code) · via Signalbox') problems.push(`bridged header: ${head}`);
      if (!(await bubble.locator('.bridged-body strong').innerText()).includes('webapp release notes')) problems.push('bridged markdown');
      if ((await page.locator('.timeline').innerText()).includes('another AI agent in this project')) problems.push('envelope shown');
      if (await page.locator('.msg-user').count()) problems.push('bridged message shown as yours');
      // Started by a chat on the other backend: links there, and back.
      const chip = page.locator('.links-bar .link-chip', { hasText: 'Started by' });
      const chipText = (await chip.innerText()).replace(/\s+/g, ' ').trim();
      if (chipText !== 'Started by Fix flaky login test') problems.push(`started-by chip: ${chipText}`);
      if (!(await chip.locator('svg[aria-label="Paseo"]').count())) problems.push('started-by chip lacks the other backend');
      await chip.click();
      await page.waitForURL('**/c/paseo/5f0c2a8e-login');
      await page.locator('.links-bar .link-chip', { hasText: 'Release notes: session fixes' }).click();
      await page.waitForURL('**/c/hermes/20260927_091500_b41d9e');
      await bubble.waitFor();
    },
  });

  await shoot('30-phone-bridge-settings', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const section = page.locator('.bridge-settings');
      await section.waitFor();
      if ((await section.locator('.bridge-state').innerText()).trim() !== 'On') problems.push('bridge state');
      // What the demo agents did through the real bridge at startup (see startDemoBridge).
      if (!(await section.innerText()).includes('1 message sent · 1 queued · 1 chat started')) problems.push('bridge counts');
      await section.locator('button', { hasText: 'Pause' }).click();
      await section.locator('button', { hasText: 'Resume' }).waitFor();
      if ((await section.locator('.bridge-state').innerText()).trim() !== 'Paused') problems.push('bridge not paused');
      // The server kept it: a fresh load says paused too.
      await page.reload();
      await page.click('button[aria-label="Settings"]');
      await section.locator('button', { hasText: 'Resume' }).waitFor();
    },
  });

  await shoot('37-phone-cloud-agents-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const section = page.locator('.cloud-agents');
      await section.waitFor();
      const codex = (checked: boolean) =>
        section.locator(`button[role="switch"][aria-label="Codex"][aria-checked="${checked}"]`);
      await codex(true).waitFor();
      await codex(true).click();
      await codex(false).waitFor();
      if (!(await section.innerText()).includes('Off')) problems.push('cloud agents: codex row not off');
      // The server kept it: a fresh load says off too.
      await page.reload();
      await page.click('button[aria-label="Settings"]');
      await codex(false).waitFor();
      await section.scrollIntoViewIfNeeded();
    },
  });

  await shoot('37b-phone-whatsapp-settings', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const section = page.locator('.whatsapp-routing');
      await section.waitFor();
      const routing = (checked: boolean) =>
        section.locator(`button[role="switch"][aria-checked="${checked}"]`);
      const back = section.locator('select[aria-label="Back to your WhatsApp chat after"]');
      if (!(await back.isEnabled())) problems.push('whatsapp: return time disabled while routing is on');
      await routing(true).click();
      await routing(false).waitFor();
      if (await back.isEnabled()) problems.push('whatsapp: return time still enabled with routing off');
      await section.locator('select[aria-label="Start a fresh WhatsApp chat"]').selectOption('8');
      // The server kept both: a fresh load shows them.
      await page.reload();
      await page.click('button[aria-label="Settings"]');
      await routing(false).waitFor();
      const fresh = await section.locator('select[aria-label="Start a fresh WhatsApp chat"]').inputValue();
      if (fresh !== '8') problems.push(`whatsapp: fresh chat after ${fresh}, not 8`);
      await section.scrollIntoViewIfNeeded();
    },
  });

  await shoot('37c-phone-settings', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const section = page.locator('.phone-settings');
      await section.waitFor();
      if (!(await section.innerText()).includes('Not set')) problems.push('phone: PIN not shown as unset');
      await section.locator('input[aria-label="New PIN"]').fill('48a26');      // letters are dropped
      if ((await section.locator('input[aria-label="New PIN"]').inputValue()) !== '4826') problems.push('phone: non-digits kept');
      await section.locator('button[type="submit"]').click();
      await section.locator('button[aria-label="Show PIN"]').waitFor();
      if ((await section.innerText()).includes('4826')) problems.push('phone: PIN visible before Show');
      await section.locator('button[aria-label="Show PIN"]').click();
      await section.locator('.pin-value').waitFor();
      if ((await section.locator('.pin-value').innerText()) !== '4826') problems.push('phone: revealed PIN wrong');
      await section.scrollIntoViewIfNeeded();
    },
  });

  await shoot('37d-phone-schedules', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      await page.locator('.settings-link', { hasText: 'Scheduled jobs' }).click();
      const list = page.locator('.schedules');
      await list.waitFor();
      const text = await list.innerText();
      for (const name of ['Book club mail', 'Morning briefing', 'Price watch: flights to Lisbon', 'Weekly digest']) {
        if (!text.includes(name)) problems.push(`schedules: ${name} missing`);
      }
      if (!text.includes('Model provider unreachable')) problems.push('schedules: failing job shows no error');
      // Paseo's schedule, with its badge, agent and runs (one failed).
      const nightly = list.locator('.schedule-job', { hasText: 'Nightly tests' });
      if (!(await nightly.locator('.source-badge.paseo').count())) problems.push('schedules: no Paseo badge');
      await nightly.locator('.schedule-head').click();
      await nightly.locator('.run-item').first().waitFor();
      const nightlyText = await nightly.innerText();
      if (!nightlyText.includes('New claude agent in ~/code/webapp')) problems.push('schedules: Paseo target missing');
      if (!nightlyText.includes('provider unavailable')) problems.push('schedules: failed Paseo run not shown');
      await nightly.locator('.schedule-head').click();
      // Expand the briefing: details, prompt and recent runs.
      await list.locator('.schedule-head', { hasText: 'Morning briefing' }).click();
      await list.locator('.run-item').first().waitFor();
      if ((await list.locator('.run-item').count()) < 2) problems.push('schedules: runs not listed');
      await list.locator('button', { hasText: 'Run now' }).click();
      await page.waitForSelector('.toast:has-text("Running \\"Morning briefing\\" now")');
      // Turn the paused digest back on.
      const digest = list.locator('button[role="switch"][aria-label="Weekly digest on"]');
      if ((await digest.getAttribute('aria-checked')) !== 'false') problems.push('schedules: digest not shown paused');
      await digest.click();
      await list.locator('button[role="switch"][aria-label="Weekly digest on"][aria-checked="true"]').waitFor();
      // New job.
      await page.locator('button', { hasText: 'New scheduled job' }).click();
      await page.locator('.schedule-builder button', { hasText: 'Fill it in yourself' }).click();
      const form = page.locator('.schedule-form');
      if (!(await form.locator('.tools-field input[value="none"]').isChecked())) problems.push('new job: tools not "Nothing" by default');
      if (!(await list.locator('.schedule-job', { hasText: 'Morning briefing' }).locator('.tools-full').count())) {
        problems.push('schedules: full-access job has no chip');
      }
      await form.locator('input').first().fill('Lunch idea');
      await form.locator('textarea').fill('Suggest somewhere new for lunch within a 5 minute walk of work.');
      await form.locator('.link-btn', { hasText: 'every day at 8am' }).click();
      await form.locator('button[type="submit"]').click();
      await list.locator('.schedule-head', { hasText: 'Lunch idea' }).waitFor();
      await list.locator('.schedule-head', { hasText: 'Morning briefing' }).scrollIntoViewIfNeeded();
    },
  });

  await shoot('58-phone-home-scheduled', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      // Recent no longer carries a Scheduled block; it has its own tab, with a failure badge.
      if (await page.locator('.scheduled-view').count()) problems.push('home: scheduled shown on Recent');
      const tab = page.locator('.view-tabs button', { hasText: 'Scheduled' });
      await tab.waitFor();
      if ((await tab.locator('.tab-badge.failed').innerText()) !== '1') problems.push('home: failed badge missing');
      await tab.click();
      const view = page.locator('.scheduled-view');
      await view.waitFor();
      await view.locator('.scheduled-section.failed').waitFor();
      const text = await view.innerText();
      if (!text.includes('Price watch: flights to Lisbon')) problems.push('scheduled tab: failing job missing');
      if (!/next up/i.test(text)) problems.push('scheduled tab: next up missing');
      if (await page.locator('.chips').count()) problems.push('scheduled tab: conversation filters still shown');
      // Ideas arrive in the background and the tab refreshes itself.
      await view.locator('.scheduled-section.next .scheduled-idea').first().waitFor({ timeout: 15000 }).catch(() =>
        problems.push('scheduled tab: idea never appeared'),
      );
      // All jobs starts folded; open it.
      await view.locator('.scheduled-section.all .scheduled-section-head').click();
      await view.locator('.scheduled-section.all .scheduled-item').first().waitFor();
      await page.screenshot({ path: `${OUT}/58a-phone-scheduled-tab.png` });
      // Search filters jobs.
      await page.fill('.search input', 'digest');
      await view.locator('.scheduled-section.all .scheduled-item', { hasText: 'Weekly digest' }).waitFor();
      if ((await view.locator('.scheduled-item', { hasText: 'Book club mail' }).count()) !== 0) problems.push('scheduled tab: search not filtering');
      await page.fill('.search input', '');
      // A job opens the Scheduled jobs sheet at that job, with its details.
      await view.locator('.scheduled-section.next .scheduled-item').first().click();
      const job = page.locator('.schedule-job.open');
      await job.waitFor();
      await job.locator('.schedule-idea:not(.muted)').waitFor();
      const detail = await job.innerText();
      for (const want of ['When', 'Created', 'Instructions']) {
        if (!detail.includes(want)) problems.push(`job detail: ${want} missing`);
      }
    },
  });

  await shoot('61-phone-scheduled-tab-new', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.locator('.view-tabs button', { hasText: 'Scheduled' }).click();
      await page.locator('.scheduled-view').waitFor();
      // The phone's New button starts the AI job builder on this tab, and it opens on screen.
      await page.locator('.fab').click();
      const builder = page.locator('.schedule-builder');
      await builder.waitFor();
      await page.waitForTimeout(600);
      const box = await builder.boundingBox();
      if (!box || box.y < 0 || box.y > phone.height - 150) problems.push(`builder: not on screen (y=${box?.y})`);
    },
  });

  await shoot('59-phone-schedule-builder', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      await page.locator('.settings-link', { hasText: 'Scheduled jobs' }).click();
      await page.locator('.schedules').waitFor();
      await page.locator('button', { hasText: 'New scheduled job' }).click();
      const builder = page.locator('.schedule-builder');
      await builder.locator('textarea').fill(
        "Every weekday at 7am, check my train line and message me only if it's delayed.",
      );
      await builder.locator('button[type="submit"]').click();
      const form = page.locator('.schedule-form');
      await form.locator('.schedule-draft-head').waitFor();
      if ((await form.locator('input').first().inputValue()) !== 'Train delay alert') problems.push('builder: name not drafted');
      const skills = form.locator('.schedule-skill input');
      if ((await skills.count()) !== 2) problems.push('builder: suggested skills missing');
      await skills.nth(1).uncheck();
      if (!(await form.locator('.tools-field input[value="web"]').isChecked())) problems.push('builder: tools pick not applied');
      if (!(await form.locator('.tools-field').innerText()).includes('transit alerts page')) problems.push('builder: tools reason missing');
      await form.locator('.schedule-skills').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/59a-phone-schedule-builder-draft.png` });
      await form.locator('button[type="submit"]').click();
      await page.locator('.schedule-head', { hasText: 'Train delay alert' }).waitFor();
    },
  });

  await shoot('60-phone-schedule-edit', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      await page.locator('.settings-link', { hasText: 'Scheduled jobs' }).click();
      const list = page.locator('.schedules');
      await list.waitFor();
      const job = list.locator('.schedule-job', { hasText: 'Weekly digest' });
      await job.locator('.schedule-head').click();
      await job.locator('button', { hasText: 'Edit' }).click();
      // The form opens inside this job, and on screen (it used to open below the whole list).
      const form = job.locator('.schedule-form');
      await form.waitFor();
      await page.waitForTimeout(600);   // smooth scroll
      const box = await form.boundingBox();
      if (!box || box.y < 0 || box.y > phone.height - 120) problems.push(`edit: form not on screen (y=${box?.y})`);
      await form.locator('input').nth(1).fill('0 9 * * 1,4');
      await page.screenshot({ path: `${OUT}/60a-phone-schedule-edit-form.png` });
      if (!(await form.locator('.tools-field input[value="keep"]').isChecked())) problems.push('edit: unpinned job not on "Keep as it is"');
      await form.locator('.tools-field input[value="all"]').check();
      await form.locator('.tools-warning').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/60b-phone-schedule-edit-full-access.png` });
      await form.locator('.tools-field input[value="keep"]').check();
      // Back on "Keep as it is" for an unpinned job: Hermes' own setting decides, which Signalbox can't see.
      if (!(await form.locator('.tools-warning').innerText()).includes("Hermes' own setting decides")) {
        problems.push('edit: no caution for an unpinned job');
      }
      await form.locator('button[type="submit"]').click();
      await job.locator('.schedule-head', { hasText: '0 9 * * 1,4' }).waitFor();
      if (!(await job.locator('.schedule-facts').innerText()).includes('Hermes decides')) problems.push('edit: pin changed by a schedule edit');
    },
  });

  // ---- Tidying up: archive a thread, see it under Archived, restore it ----
  const ISSUES = '/c/paseo/c2b4e6f8-hermes';
  await shoot('38-phone-thread-actions', {
    ...phone,
    dark: false,
    path: ISSUES,
    ready: 'button[aria-label="Thread actions"]',
    act: async (page) => {
      await page.click('button[aria-label="Thread actions"]');
      await page.locator('.thread-actions').waitFor();
    },
  });
  await shoot('39-phone-archived-dark', {
    ...phone,
    dark: true,
    path: ISSUES,
    ready: 'button[aria-label="Thread actions"]',
    act: async (page) => {
      await page.click('button[aria-label="Thread actions"]');
      await page.locator('.thread-actions button', { hasText: 'Archive' }).click();
      // Back to the inbox, without it.
      await page.waitForURL((url) => url.pathname === '/');
      await page.locator('.row').first().waitFor();
      if (await page.locator('.row', { hasText: 'Summarize open issues' }).count()) problems.push('archived chat still listed');
      await page.click('button[aria-label="Settings"]');
      await page.locator('.tidy-settings button', { hasText: 'View' }).click();
      await page.locator('.archived-list .kv', { hasText: 'Summarize open issues' }).waitFor();
    },
    after: async (page) => {
      // Restore puts it back (the later shots expect the demo as it was).
      await page.locator('.archived-list .kv', { hasText: 'Summarize open issues' }).locator('button', { hasText: 'Restore' }).click();
      await page.locator('.archived-empty').waitFor();
      await page.locator('.sheet button[aria-label="Close"]').first().click().catch(() => {});
      await page.goto(ORIGIN + '/');
      await page.locator('.row', { hasText: 'Summarize open issues' }).waitFor();
    },
  });
  await shoot('40-phone-archive-folder', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('.view-toggle button:has-text("Projects")');
      const archive = page.locator('.project-head button[aria-label^="Archive "]').first();
      await archive.waitFor();
      await archive.click();
      await page.locator('.confirm-card').waitFor();
      if (!(await page.locator('.confirm-card').innerText()).includes('comes back as soon as something new starts')) {
        problems.push('archive folder: no "comes back" note');
      }
    },
    after: async (page) => {
      await page.locator('.confirm-card button', { hasText: 'Cancel' }).click();
    },
  });
  await shoot('41-phone-tidy-settings-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const section = page.locator('.tidy-settings');
      await section.waitFor();
      await section.locator('.muted', { hasText: 'in Hermes and Paseo' }).waitFor();
      await section.scrollIntoViewIfNeeded();
    },
  });

  // ---- Passwords and codes Hermes asks for ----
  /** A secret must reach the server in the answer, and never come back to the page in any form. */
  const secretNeverLeaks = async (page: Page, seen: Seen, secret: string, label: string, sends = 1) => {
    if (seen.posts.filter((body) => body.includes(secret)).length !== sends) problems.push(`${label}: not sent ${sends}×`);
    if ((await Promise.all(seen.responses)).some((body) => body.includes(secret))) problems.push(`${label}: in a response`);
    if (seen.frames.some((frame) => frame.includes(secret))) problems.push(`${label}: in a live update`);
    if (seen.console.some((line) => line.includes(secret))) problems.push(`${label}: in the console`);
    if ((await page.content()).includes(secret) || (await page.locator('body').innerText()).includes(secret)) {
      problems.push(`${label}: in the page`);
    }
    const stored = String(await page.evaluate('JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])'));
    if (stored.includes(secret)) problems.push(`${label}: in browser storage`);
    const fields = await page.locator('input, textarea').evaluateAll((els) => els.map((el) => (el as unknown as { value: string }).value));
    if (fields.some((value) => value.includes(secret))) problems.push(`${label}: left in a field`);
  };
  const SUDO = 'sb-marker-sudo-hunter2-7f3a91';
  const OTP = 'sb-marker-otp-5510';
  const secretCard = (page: Page) => page.locator('.approval-secret');

  await shoot('31-phone-secret-sudo', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      // Waiting on a password counts as needing you, like any approval.
      const row = page.locator('.row', { hasText: 'Set up the home server' });
      if (!(await row.innerText()).includes('Needs you')) problems.push('secret approval not "needs you"');
      await row.click();
      const field = secretCard(page).locator('input');
      await field.waitFor();
      const attrs = await field.evaluate((el) =>
        ['type', 'autocomplete', 'autocapitalize', 'spellcheck', 'inputmode'].map((a) => el.getAttribute(a)),
      );
      if (attrs.join() !== 'password,off,off,false,') problems.push(`sudo field attributes: ${attrs.join()}`);
      if (!(await secretCard(page).innerText()).includes('TLS ends at Cloudflare')) problems.push('secret note');
      await field.fill(SUDO);
      const send = secretCard(page).locator('button[aria-label="Send"]');
      await until('Send to arm', async () => !(await send.isDisabled()));
      await send.click();
      // Sudo runs as root: a second, explicit step, and nothing sent yet.
      const confirm = secretCard(page).locator('.secret-confirm');
      await confirm.waitFor();
      if (!(await confirm.innerText()).includes('Send your sudo password to run this command?')) problems.push('sudo confirm text');
      if ((await secretCard(page).locator('input').count()) !== 0) problems.push('field shown while confirming');
    },
    after: async (page, seen) => {
      if (seen.posts.some((body) => body.includes(SUDO))) problems.push('sudo password sent before Confirm');
      await secretCard(page).locator('button', { hasText: 'Back' }).click();
      await secretCard(page).locator('button[aria-label="Send"]').click();
      await secretCard(page).locator('button', { hasText: 'Confirm' }).click();
      await secretCard(page).waitFor({ state: 'detached' });
      await page.locator('.msg-assistant', { hasText: 'Done. It went through.' }).waitFor();
      await secretNeverLeaks(page, seen, SUDO, 'sudo password');
    },
  });

  await shoot('32-phone-secret-2fa', {
    ...phone,
    dark: false,
    path: '/c/hermes/20260927_102000_b10b10',
    ready: '.approval-secret input',
    act: async (page) => {
      const field = secretCard(page).locator('input');
      const attrs = await field.evaluate((el) => ['type', 'inputmode', 'autocomplete'].map((a) => el.getAttribute(a)));
      if (attrs.join() !== 'password,numeric,one-time-code') problems.push(`code field attributes: ${attrs.join()}`);
      await field.fill(OTP);
      const send = secretCard(page).locator('button[aria-label="Send"]');
      await until('Send to arm', async () => !(await send.isDisabled()));
    },
    after: async (page, seen) => {
      await secretCard(page).locator('button[aria-label="Send"]').click();
      // A code has no second step.
      await secretCard(page).waitFor({ state: 'detached' });
      await page.locator('.msg-assistant', { hasText: 'Done. It went through.' }).waitFor();
      await secretNeverLeaks(page, seen, OTP, '2FA code');
    },
  });

  // ---- A very long approval never takes over the screen ----
  const inView = async (page: Page, selector: string) => {
    const vp = page.viewportSize()!;
    const box = await page.locator(selector).first().boundingBox();
    return Boolean(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 0.5 && box.y + box.height <= vp.height + 0.5);
  };
  const approvalInReach = async (page: Page, label: string, approve: boolean) => {
    await page.waitForTimeout(250); // let the layout follow a resize
    const vp = page.viewportSize()!;
    const dock = await page.locator('.approval-dock').boundingBox();
    if (!dock || dock.height > vp.height * 0.6 + 1) {
      problems.push(`${label}: approval takes ${Math.round(dock?.height ?? 0)} of ${vp.height}px`);
    }
    const reach: Array<[string, string]> = [
      ['.approval .btn-danger', 'Deny'],
      ['.approval .btn-approve', 'Approve'],
      ['button[aria-label="Stop"]', 'Stop'],
      ['.composer textarea', 'message box'],
    ];
    for (const [selector, what] of reach) if (!(await inView(page, selector))) problems.push(`${label}: ${what} out of reach`);
    await page.locator('.approval .btn-danger').click({ trial: true });
    await page.locator('button[aria-label="Stop"]').click({ trial: true });
    if (approve) await page.locator('.approval .btn-approve').click({ trial: true });
    // The conversation above the card can still be scrolled.
    const scrolls = await page.locator('.timeline').evaluate((el) => {
      const t = el as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
      const before = t.scrollTop;
      t.scrollTop = before > 0 ? 0 : t.scrollHeight;
      return t.clientHeight >= 40 && t.scrollTop !== before;
    });
    if (!scrolls) problems.push(`${label}: the timeline can't scroll`);
  };

  await shoot('33-phone-long-approval', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260927_103000_5ca1ab',
    ready: '.approval-dock .approval',
    act: async (page) => {
      await until('the card to arm', async () => !(await page.locator('.approval .btn-danger').isDisabled()));
      // A title this long starts folded; the long command waits to be reviewed.
      if (!(await page.locator('.approval-title.folded').count())) problems.push('long title not folded');
      if (!(await page.locator('.approval .btn-approve').isDisabled())) problems.push('approve before reviewing the command');
      await approvalInReach(page, 'portrait', false);
    },
    after: async (page) => {
      await page.locator('.approval-more').click();
      await page.locator('.approval .link-btn', { hasText: 'Show everything' }).click();
      if (await page.locator('.approval .btn-approve').isDisabled()) problems.push('approve still locked after review');
      // Everything open is the longest the card gets.
      await approvalInReach(page, 'portrait, all open', true);
      await page.setViewportSize({ width: 852, height: 393 });
      await approvalInReach(page, 'landscape', true);
      await page.setViewportSize({ width: 393, height: 440 }); // about what's left above a phone keyboard
      await approvalInReach(page, 'keyboard up', true);
      await page.setViewportSize({ width: phone.width, height: phone.height });
      // And Stop really stops the run from here.
      await page.locator('button[aria-label="Stop"]').click();
      await page.locator('.approval-dock').waitFor({ state: 'detached' });
      await page.locator('.notice', { hasText: 'Stopped' }).waitFor();
    },
  });

  // ---- Saving a login for Hermes' vault ----
  const USER = 'sb-marker-user-4c1d';
  const PASS = 'sb-marker-pass-9e2b';
  await shoot('34-phone-secret-login', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260927_104500_10e1a5',
    ready: '.approval-login input[type="password"]',
    expectErrors: /status of 503/,
    act: async (page) => {
      const name = secretCard(page).locator('input[autocomplete="username"]');
      const password = secretCard(page).locator('input[type="password"]');
      const attrs = await name.evaluate((el) => ['type', 'autocomplete', 'autocapitalize', 'spellcheck'].map((a) => el.getAttribute(a)));
      if (attrs.join() !== 'text,username,off,false') problems.push(`login name field: ${attrs.join()}`);
      if ((await password.getAttribute('autocomplete')) !== 'new-password') problems.push('login password autocomplete');
      if (!(await secretCard(page).innerText()).includes('Username or email')) problems.push('login name label');
      if (!(await secretCard(page).innerText()).includes('TLS ends at Cloudflare')) problems.push('login note');
      const send = secretCard(page).locator('.approval-foot .btn-approve');
      await page.waitForTimeout(800); // armed
      await password.fill('correct horse battery');
      if (!(await send.isDisabled())) problems.push('login sendable without a username');
      await name.fill('me@example.com');
      await until('Send with both fields', async () => !(await send.isDisabled()));
    },
    after: async (page, seen) => {
      const name = secretCard(page).locator('input[autocomplete="username"]');
      const password = secretCard(page).locator('input[type="password"]');
      const send = secretCard(page).locator('.approval-foot .btn-approve');
      // A send that fails still clears both fields, and says why.
      await page.route(
        '**/approvals/**',
        (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Hermes is busy. Try again.' }) }),
        { times: 1 },
      );
      await name.fill(USER);
      await password.fill(PASS);
      await send.click();
      await secretCard(page).locator('.approval-warn', { hasText: 'Hermes is busy' }).waitFor();
      if ((await name.inputValue()) !== '' || (await password.inputValue()) !== '') problems.push('login fields kept after a failed send');
      await page.unroute('**/approvals/**');
      await name.fill(USER);
      await password.fill(PASS);
      await send.click();
      await secretCard(page).waitFor({ state: 'detached' });
      await page.locator('.msg-assistant', { hasText: 'Done. It went through.' }).waitFor();
      await secretNeverLeaks(page, seen, USER, 'login name', 2);
      await secretNeverLeaks(page, seen, PASS, 'login password', 2);
    },
  });

  // ---- Everything nested under whatever started it ----
  const notesApp = (page: Page) => page.locator('.project', { hasText: 'notes-app' });
  await shoot('35-phone-projects-nested', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      // Recent: idle sub-agents stay out of the way; working ones show; search finds the rest.
      const recent = await page.locator('.list').innerText();
      if (recent.includes('Benchmark SQLite sync')) problems.push('idle sub-agent in Recent');
      if (!(await page.locator('.row', { hasText: 'Survey CRDT libraries' }).locator('.tag-subagent').count())) {
        problems.push('working sub-agent not in Recent');
      }
      await page.fill('.search input', 'Benchmark');
      if (!(await page.locator('.row', { hasText: 'Benchmark SQLite sync' }).count())) problems.push('search misses idle sub-agents');
      await page.fill('.search input', '');

      await page.click('.view-toggle button:has-text("Projects")');
      const project = notesApp(page);
      await project.waitFor();
      const plan = project.locator('.lane-hermes .thread', { hasText: 'Plan the notes sync redesign' });
      // A Paseo agent started by a Hermes chat nests under it, in the Hermes lane.
      if (!(await plan.locator('.thread-children .row', { hasText: 'Prototype the sync engine' }).count())) problems.push('cross-backend nest');
      // Sub-agents start folded behind one row.
      const toggle = plan.locator('.subagents-toggle').first();
      if ((await toggle.innerText()).replace(/\s+/g, ' ').trim() !== '3 sub-agents · 1 working') problems.push(`folded row: ${await toggle.innerText()}`);
      if (await plan.locator('.row', { hasText: 'Benchmark SQLite sync' }).count()) problems.push('sub-agents not folded');
      await toggle.click();
      const runs = await plan.locator('.subagents-list').first().locator('.row-title').allInnerTexts();
      if (runs.join() !== 'Survey CRDT libraries,Benchmark SQLite sync,Check licence terms') problems.push(`runs: ${runs.join()}`);
      // Runs of the Hermes session inside a Paseo agent, found through its alias.
      const issues = project.locator('.lane-paseo .thread', { hasText: 'Summarize open issues' });
      await issues.locator('.subagents-toggle').click();
      const found = await issues.locator('.subagents-list .row-title').allInnerTexts();
      if (found.sort().join() !== 'Find duplicate issues,Triage issues labelled bug') problems.push(`alias runs: ${found.join()}`);
      // Orphans: working shows on its own, tagged; idle is hidden.
      const orphan = project.locator('.lane-paseo .thread > .row', { hasText: 'Reindex the search' });
      if (!(await orphan.locator('.tag-subagent').count())) problems.push('working orphan sub-agent');
      if ((await project.innerText()).includes('Summarize last week')) problems.push('idle orphan sub-agent shown');
      // Opened stays opened.
      await page.reload();
      await page.click('.view-toggle button:has-text("Projects")');
      await notesApp(page).locator('.row', { hasText: 'Benchmark SQLite sync' }).waitFor();
      await notesApp(page).scrollIntoViewIfNeeded();
    },
  });

  await shoot('36-phone-subagent-view', {
    ...phone,
    dark: true,
    path: '/c/hermes/20260927_083100_run0a1',
    ready: '.readonly-bar',
    act: async (page) => {
      const bar = (await page.locator('.readonly-bar').innerText()).replace(/\s+/g, ' ').trim();
      if (bar !== 'Sub-agent of Plan the notes sync redesign · read-only') problems.push(`read-only line: ${bar}`);
      for (const selector of ['.composer', '.controls-strip', 'button[aria-label="Stop"]', 'button[aria-label="Send"]']) {
        if (await page.locator(selector).count()) problems.push(`sub-agent view has ${selector}`);
      }
    },
    after: async (page) => {
      await page.locator('.readonly-bar .link-btn').click();
      await page.waitForURL('**/c/hermes/20260927_083000_5a1e11');
      await page.locator('.composer').waitFor();
    },
  });

  // Files dragged in from the desktop: synthetic drag events carrying real File objects, as Chrome sends them.
  const dragFiles = (page: Page, files: Array<[name: string, type: string, content: string]>) =>
    page.evaluate(`(() => {
      const data = new DataTransfer();
      for (const [name, type, content] of ${JSON.stringify(files)}) data.items.add(new File([content], name, { type }));
      const fire = (kind) => document.body.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }));
      // Held over the page: dragover keeps coming until the drop.
      fire('dragenter');
      const held = setInterval(() => fire('dragover'), 80);
      window.dropNow = () => { clearInterval(held); fire('drop'); };
    })()`);
  const dropNow = (page: Page) => page.evaluate('window.dropNow()');
  const docx: [string, string, string] = ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK\u0003\u0004\u0000'];
  const exe: [string, string, string] = ['setup.exe', 'application/x-msdownload', 'MZ\u0000\u0001'];

  await shoot('42-desktop-drop-files', {
    width: 1280,
    height: 820,
    dark: true,
    path: '/c/hermes/20260927_080000_abcdef',
    ready: '.cmd',
    act: async (page) => {
      await dragFiles(page, [['notes.md', 'text/markdown', '# Notes\n'], docx, exe]);
      await page.waitForSelector('.drop-overlay:not(.refused):has-text("Drop to attach to your next message")');
    },
    after: async (page) => {
      await dropNow(page);
      await page.locator('.composer .attach-chip').first().waitFor();
      const chips = await page.locator('.composer .attach-name').allInnerTexts();
      if (chips.join() !== 'notes.md,report.docx') problems.push(`dropped chips: ${chips.join()}`);
      if (!(await page.locator('.toast:has-text("setup.exe: only photos, PDFs, text, Office files")').count())) {
        problems.push('no word about the refused .exe');
      }
      await page.waitForSelector('.drop-overlay', { state: 'detached' });
      // Sent like a picked file.
      await box(page).fill('Dropped in');
      await page.click('button[aria-label="Send"]');
      await page.waitForSelector('.msg-user:not(.pending) .msg-file:has-text("notes.md")');
    },
  });

  await shoot('43-phone-new-chat-folder', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('.fab');
      const folder = page.locator('.sheet input[aria-label="Folder for this Hermes chat"]');
      await folder.fill('/home/me/code/nope/deeper');
      await page.waitForSelector('.sheet .folder-note.bad:has-text("doesn\'t exist")');
      if (await page.locator('.sheet-foot .btn-primary').isEnabled()) problems.push('started with a folder that cannot be made');
      await folder.fill('/home/me/code/newproj');
      await page.waitForSelector('.sheet .folder-note:not(.bad):has-text("New folder")');
      // With the sheet open, dropped files go to the new chat, not the inbox behind it.
      await dragFiles(page, [['plan.md', 'text/markdown', '# Plan\n']]);
      await page.waitForSelector('.drop-overlay:has-text("Drop to attach to the new chat")');
      await dropNow(page);
      await page.waitForSelector('.sheet .attach-chip:has-text("plan.md")');
      await page.locator('.sheet textarea').fill('Set up the new project');
    },
    after: async (page) => {
      await page.click('.sheet-foot .btn-primary');
      await page.waitForSelector('.msg-user');
      // Made before the chat started (through Paseo, as the owner).
      if ((await sources.paseo.folderStatus('/home/me/code/newproj')) !== 'exists') problems.push('new folder was not made');
    },
  });

  // ---- Connectors: the page, signing in, and a mail trigger ----
  const openConnectors = async (page: Page) => {
    await page.click('button[aria-label="Settings"]');
    await page.click('button.settings-link');
    await page.waitForSelector('.connector-grid');
  };
  await shoot('44-phone-connectors-dark', { ...phone, dark: true, path: '/', ready: '.row', act: openConnectors });
  await shoot('45-phone-connect-review-light', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await openConnectors(page);
      const dropbox = page.locator('.connector-card', { hasText: 'Dropbox' });
      await dropbox.locator('button', { hasText: 'Connect' }).click();
      await page.waitForSelector('.connector-dialog .connect-can');
    },
    after: async (page) => {
      await page.click('.connector-dialog .btn-primary');
      await page.waitForSelector('.connector-dialog a[href="https://example.com/sign-in/dropbox"]');
      await page.screenshot({ path: join(OUT, '45b-phone-connect-waiting-light.png') });
      // The demo sign-in finishes on its own; the card comes back connected.
      await page.waitForSelector('.connector-dialog', { state: 'detached', timeout: 10_000 });
      await page.locator('.connector-card.state-connected', { hasText: 'Dropbox' }).waitFor();
      const fireflies = page.locator('.connector-card', { hasText: 'Fireflies' });
      if (!(await fireflies.innerText()).includes('Needs attention')) problems.push('connectors: fireflies not flagged');
    },
  });
  await shoot('46-desktop-connectors-light', {
    width: 1280,
    height: 900,
    dark: false,
    path: '/',
    ready: '.row',
    act: openConnectors,
  });
  await shoot('47-phone-trigger-form-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await openConnectors(page);
      await page.click('button.trigger-add');
      const form = page.locator('.trigger-form');
      await form.locator('input').first().fill('Invoices');
      await form.locator('.link-btn', { hasText: 'subject:invoice' }).click();
      await form.locator('textarea').fill('Add the amount and due date to my notes and tell me.');
      await form.scrollIntoViewIfNeeded();
    },
    after: async (page) => {
      await page.click('.trigger-form button[type="submit"]');
      await page.locator('.trigger-row', { hasText: 'Invoices' }).waitFor();
      if (!(await page.locator('.trigger-row', { hasText: 'Invoices' }).innerText()).includes('subject:invoice')) {
        problems.push('trigger: query not listed');
      }
    },
  });

  // ---- Voice mode -------------------------------------------------------------
  const voiceChat = '/c/paseo/5f0c2a8e-login';
  const said = (page: Page) =>
    until('the transcript in the message box', async () => (await box(page).inputValue()).includes(DEMO_TRANSCRIPT), 10_000);
  await shoot('48-phone-voice-hold-dark', {
    ...phone,
    dark: true,
    path: voiceChat,
    ready: '.voice-btn',
    act: async (page) => {
      const mic = (await page.locator('.voice-btn').boundingBox())!;
      await page.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2);
      await page.mouse.down();
      await page.waitForSelector('.voice-bar.listening');
      await page.waitForTimeout(1500);
    },
    after: async (page) => {
      const before = speech.heard;
      await page.mouse.up();
      await said(page);
      // 1.5 s held: about 48,000 bytes of 16 kHz audio should have come through the worklet and the socket.
      if (speech.heard - before < 32_000) problems.push(`voice: only ${speech.heard - before} bytes of audio arrived`);
      if (await page.locator('.voice-bar').count()) problems.push('voice: the bar stayed after the transcript');
      if (await page.locator('.send-btn').isDisabled()) problems.push('voice: send not offered for the transcript');
    },
  });
  await shoot('49-phone-voice-tap-light', {
    ...phone,
    dark: false,
    path: voiceChat,
    ready: '.voice-btn',
    act: async (page) => {
      await page.locator('.voice-btn').click(); // a quick tap: record until the next tap
      await page.waitForSelector('.voice-bar.listening');
      await page.waitForTimeout(1200);
      if (!(await page.locator('.voice-bar').innerText()).includes('Cancel')) problems.push('voice: tap mode has no Cancel');
    },
    after: async (page) => {
      await page.locator('.voice-btn').click();
      await said(page);
    },
  });
  await shoot('50-phone-voice-listen-dark', {
    ...phone,
    dark: true,
    path: digest, // a finished reply: Listen shows once a reply is done
    ready: '.msg-listen',
    act: async (page) => {
      const before = speech.spoken.length;
      await page.locator('.msg-listen').first().click();
      await page.waitForSelector('.voice-bar.reading');
      await until('playback', async () => (await page.locator('.voice-bar').innerText()).includes('Reading the reply aloud'));
      if (speech.spoken.length === before) problems.push('voice: Listen asked for no speech');
    },
    after: async (page) => {
      await page.locator('.voice-bar-btn', { hasText: 'Stop' }).click();
      await page.locator('.voice-bar').waitFor({ state: 'detached' });
    },
  });
  await shoot('51-phone-settings-voice-light', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const title = page.locator('.group-title', { hasText: 'Voice' });
      await title.waitFor();
      await title.scrollIntoViewIfNeeded();
      const before = speech.spoken.length;
      await page.locator('select[aria-label="Voice"]').selectOption('bm_george');
      // Picking a voice saves it for everywhere, then plays a sample of it right here.
      await page.locator('select[aria-label="Voice"]:enabled').waitFor();
      await page.waitForTimeout(500);
      if (!speech.spoken.slice(before).some((t) => t.includes('George'))) problems.push('voice: picking a voice played no sample');
      const played = speech.spoken.length;
      await page.click('button[aria-label="Play this voice"]');
      await page.waitForTimeout(500);
      if (speech.spoken.length === played) problems.push('voice: the play button asked for no speech');
    },
    after: async (page) => {
      // The server keeps it (the voice tests cover restarts); the page shows the shared choice.
      const shared = await page.locator('select[aria-label="Voice"]').inputValue();
      if (shared !== 'bm_george') problems.push(`voice: the shared voice was not kept (${shared})`);
    },
  });

  // ---- For you -------------------------------------------------------------------
  await shoot('52-phone-foryou-inbox-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.foryou-strip',
    act: async (page) => {
      const badge = (await page.locator('.foryou-btn .badge').innerText()).trim();
      if (badge !== '5') problems.push(`for you: the badge says ${badge}, not 5`);
    },
  });
  await shoot('53-phone-foryou-sheet-light', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.foryou-btn',
    act: async (page) => {
      await page.click('.foryou-btn');
      await page.locator('.feed-card').first().waitFor();
      const count = await page.locator('.feed-card').count();
      if (count !== 5) problems.push(`for you: ${count} cards, not 5`);
      await page.locator('.feed-card', { hasText: 'RSVP' }).getByRole('button', { name: 'Do it' }).click();
      await page.locator('.feed-confirm').waitFor();
      if (!(await page.locator('.feed-confirm blockquote').innerText()).includes("bring snacks")) {
        problems.push('for you: "Do it" does not show what Hermes will get');
      }
      await page.locator('.feed-card .feed-meta').first().scrollIntoViewIfNeeded();
    },
    after: async (page) => {
      await page.locator('.feed-card', { hasText: 'Haircut' }).getByRole('button', { name: 'Not now' }).click();
      await page.locator('.feed-card', { hasText: 'Haircut' }).waitFor({ state: 'detached' });
      await page.locator('.feed-card', { hasText: 'GitHub' }).getByRole('button', { name: 'Less like this' }).click();
      await page.locator('.feed-card', { hasText: 'GitHub' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Send to Hermes' }).click();
      await until('the chat "Do it" started', async () => new URL(page.url()).pathname.startsWith('/c/hermes/'));
      await page.goto(ORIGIN + '/');
      await page.waitForSelector('.foryou-btn');
      if (await page.locator('.foryou-strip, .foryou-btn .badge').count()) problems.push('for you: still "new" after the sheet was opened');
    },
  });
  await shoot('54-phone-settings-foryou-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await page.click('button[aria-label="Settings"]');
      const title = page.locator('.group-title', { hasText: 'For you' });
      await title.waitFor();
      await page.locator('.less-like-chip', { hasText: 'GitHub notifications' }).waitFor();
      if (!(await page.getByRole('switch', { name: 'Notifications on this device' }).count())) {
        problems.push('for you: no switch for notifications on this device');
      }
      await title.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    },
    after: async (page) => {
      // The notifications service worker loads under the page's CSP (subscribing needs a real push service).
      const sw = await page.evaluate(async () => {
        type Registration = { active?: { scriptURL: string } | null };
        const workers = (navigator as unknown as {
          serviceWorker: { register(url: string, options: { scope: string }): Promise<Registration>; ready: Promise<Registration> };
        }).serviceWorker;
        await workers.register('/sw.js', { scope: '/' });
        return (await workers.ready).active?.scriptURL ?? '';
      });
      if (!sw.endsWith('/sw.js')) problems.push(`for you: the service worker didn't start (${sw})`);
      await page.locator('select[aria-label="How often Hermes speaks up"]').selectOption('high');
      await until('the level saved', async () => (await page.locator('.foryou-settings').innerText()).includes('every hour'));
    },
  });

  const openSkills = async (page: Page) => {
    await page.click('button[aria-label="Settings"]');
    await page.locator('.settings-link', { hasText: 'Skills' }).click();
    await page.locator('.skills-list').waitFor();
  };

  await shoot('55-phone-skills-light', {
    ...phone,
    dark: false,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await openSkills(page);
      const list = page.locator('.skills-list');
      // A copy changed in one app opens the "Needs a look" filter first.
      if (!(await page.locator('.skills-filters .skills-chip[aria-pressed="true"]', { hasText: 'Needs a look' }).count())) problems.push('skills: attention filter not first');
      await list.locator('.skill-head', { hasText: 'research-to-doc' }).click();
      const row = list.locator('.skill-row', { hasText: 'research-to-doc' });
      if (!(await row.innerText()).includes('Changed in Claude Code')) problems.push('skills: edited copy not explained');
      if (!(await row.locator('button', { hasText: 'Use everywhere' }).count())) problems.push('skills: no "use everywhere"');
    },
    after: async (page) => {
      const row = page.locator('.skill-row', { hasText: 'research-to-doc' });
      await row.locator('button', { hasText: 'Put shared back' }).click();
      await page.waitForSelector('.toast:has-text("Put the shared research-to-doc back")');
      // All skills: the Hermes-made one shares only after a second look at its scan.
      await page.locator('.skills-filters .skills-chip', { hasText: 'All' }).click();
      const planner = page.locator('.skill-row', { hasText: 'meal-planner' });
      await planner.locator('.skill-head').click();
      await planner.locator('button', { hasText: 'Share with every app' }).click();
      await planner.locator('.skill-scan').waitFor();
      if (!(await planner.innerText()).includes('Fetches a URL with curl')) problems.push('skills: scan findings not shown');
      await planner.locator('button', { hasText: 'Share anyway' }).click();
      await page.waitForSelector('.toast:has-text("meal-planner is now shared")');
      // Windows Claude Code is switched off for paseo; the switch says so, and turns back on.
      const paseoRow = page.locator('.skill-row', { hasText: 'Paseo reference' });
      await paseoRow.locator('.skill-head').click();
      const sw = paseoRow.locator('button[role="switch"][aria-label="paseo in Windows Claude Code"]');
      if ((await sw.getAttribute('aria-checked')) !== 'false') problems.push('skills: excluded copy shown on');
      await sw.click();
      await paseoRow.locator('button[role="switch"][aria-label="paseo in Windows Claude Code"][aria-checked="true"]').waitFor();
      // A linux-only skill can't be switched on for Windows.
      const flight = page.locator('.skill-row', { hasText: 'flight-search' });
      await flight.locator('.skill-head').click();
      if (!(await flight.locator('button[role="switch"][aria-label="flight-search in Windows Claude Code"]').isDisabled())) {
        problems.push('skills: other-OS switch is enabled');
      }
    },
  });

  await shoot('56-phone-skills-news-dark', {
    ...phone,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await openSkills(page);
      await page.locator('[role="tab"]', { hasText: "What's new" }).click();
      const news = page.locator('.skills-news');
      await news.waitFor();
      const text = await news.innerText();
      if (!text.includes('meal-planner') || !text.includes('Windows .agents')) problems.push('skills: events missing');
    },
  });

  await shoot('57-desktop-skills-market-dark', {
    width: 1280,
    height: 900,
    dark: true,
    path: '/',
    ready: '.row',
    act: async (page) => {
      await openSkills(page);
      await page.locator('[role="tab"]', { hasText: 'Marketplace' }).click();
      await page.locator('input[aria-label="Search the marketplace"]').fill('pdf');
      await page.locator('form.skills-search button[type="submit"]').click();
      await page.locator('.market-row', { hasText: 'pdf-tools' }).click();
      await page.locator('.market-detail pre').waitFor();
      await page.locator('button', { hasText: 'Scan and install for every app' }).click();
      await page.locator('.skill-scan').waitFor();
      const scan = await page.locator('.skill-scan').innerText();
      if (!scan.includes('Downloads and runs a binary')) problems.push('skills: hub scan findings not shown');
      if (!(await page.locator('button', { hasText: 'Install anyway' }).count())) problems.push('skills: no second confirm');
    },
  });

  await shoot('21-desktop-slash-menu', {
    width: 1280,
    height: 820,
    dark: true,
    path: '/c/hermes/20260927_080000_abcdef',
    ready: '.cmd',
    act: async (page) => {
      await box(page).fill('/');
      await page.waitForSelector('.composer [role="listbox"]');
      await box(page).press('ArrowDown');
      await box(page).press('ArrowDown');
    },
  });
} finally {
  feed.stop();
  await browser.close();
  edge.close();
  await app.close();
  bridge.stop();
}

if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('ui-check passed');
