// Renders the app icons (PNG) from SVG with headless Chrome. Run once after
// changing the logo: node scripts/make-icons.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const svg = ({ rounded, scale }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a3243"/><stop offset="1" stop-color="#0e1117"/></linearGradient>
    <radialGradient id="a" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#ffe3a3"/><stop offset="0.55" stop-color="#f2b54a"/><stop offset="1" stop-color="#b8780f"/></radialGradient>
    <radialGradient id="t" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#b4fbec"/><stop offset="0.55" stop-color="#35c9b0"/><stop offset="1" stop-color="#0d8f7c"/></radialGradient>
  </defs>
  <rect width="32" height="32" rx="${rounded ? 7 : 0}" fill="url(#bg)"/>
  <g transform="translate(16 16) scale(${scale}) translate(-16 -16)">
    <rect x="10" y="4.5" width="12" height="23" rx="6" fill="#05070b"/>
    <circle cx="16" cy="10.6" r="3.8" fill="url(#a)"/>
    <circle cx="16" cy="21.4" r="3.8" fill="url(#t)"/>
  </g>
</svg>`;

const targets = [
  { file: 'web/public/icons/icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'web/public/icons/icon-512.png', size: 512, rounded: true, scale: 1 },
  // Maskable: full bleed, glyph inside the 80% safe zone.
  { file: 'web/public/icons/maskable-512.png', size: 512, rounded: false, scale: 0.78 },
  // iOS applies its own corner mask.
  { file: 'web/public/apple-touch-icon.png', size: 180, rounded: false, scale: 0.92 },
];

mkdirSync('web/public/icons', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg(t)}</body></html>`,
  );
  await page.screenshot({ path: t.file, omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log('wrote', t.file);
}
await browser.close();
