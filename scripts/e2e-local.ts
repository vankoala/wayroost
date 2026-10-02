// End-to-end check of the *built* server against the real local Hermes and
// Paseo, with a local stand-in for Cloudflare Access (own JWKS + an "edge"
// proxy that stamps the JWT). Read-only: it only loads the inbox.
//   npm run build && npx tsx scripts/e2e-local.ts <output-dir>
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createLocalAccess, startEdge, startJwksServer } from './lib/local-access.js';

const OUT = resolve(process.argv[2] ?? 'e2e-shots');
const APP_PORT = 8797;
const EDGE_PORT = 8798;
const JWKS_PORT = 8799;
mkdirSync(OUT, { recursive: true });

const access = await createLocalAccess({ issuer: `http://127.0.0.1:${JWKS_PORT}`, aud: 'local-e2e' });
const jwks = await startJwksServer(JWKS_PORT, access.jwk);

const dir = mkdtempSync(join(tmpdir(), 'sb-e2e-'));
const configPath = join(dir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    listen: { host: '127.0.0.1', port: APP_PORT },
    publicOrigin: `http://127.0.0.1:${EDGE_PORT}`,
    access: { teamDomain: access.issuer, aud: access.aud, allowedEmails: [access.email] },
    stateDir: join(dir, 'state'),
  }),
);
const server = spawn('node', [resolve('dist/server/index.js')], {
  env: { ...process.env, SIGNALBOX_CONFIG: configPath, LOG_LEVEL: 'warn', SIGNALBOX_DEV_ALLOW_LOOPBACK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const edge = await startEdge({ port: EDGE_PORT, appPort: APP_PORT, token: access.token });

const problems: string[] = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
try {
  // Direct hits on the app without the edge must be refused.
  await new Promise((r) => setTimeout(r, 1500));
  const direct = await fetch(`http://127.0.0.1:${APP_PORT}/api/me`, { headers: { 'x-signalbox-request': '1' } });
  if (direct.status !== 401) problems.push(`direct request without token returned ${direct.status}`);

  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${EDGE_PORT}/`);
  await page.waitForSelector('.row', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const rows = await page.locator('.row').count();
  const connectCard = await page.locator('.connect-card').count();
  console.log(`inbox rows: ${rows}, hermes connect card: ${connectCard}`);
  await page.screenshot({ path: join(OUT, 'e2e-inbox.png') });
  await page.click('.view-toggle button:has-text("Projects")');
  await page.waitForSelector('.project');
  console.log(`projects: ${await page.locator('.project-name').allInnerTexts()}`);
  console.log(`hermes-in-paseo tags: ${await page.locator('.tag-linked').count()}, nested sub-agents: ${await page.locator('.thread-children .row').count()}`);
  await page.screenshot({ path: join(OUT, 'e2e-projects.png') });
  await page.click('.view-toggle button:has-text("Recent")');
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('.sheet');
  await page.screenshot({ path: join(OUT, 'e2e-settings.png') });
} finally {
  await browser.close();
  edge.close();
  jwks.close();
  server.kill('SIGTERM');
}
if (problems.length) {
  console.error('PROBLEMS:\n' + problems.join('\n') + '\nSERVER LOG:\n' + serverLog.join(''));
  process.exit(1);
}
console.log('e2e-local passed');
