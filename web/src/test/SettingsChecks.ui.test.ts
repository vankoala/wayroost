import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const executablePath = process.env.CHROME ?? '/opt/google/chrome/chrome';
let browser: Browser;
let directory: string;

/** Render demo responses in a local file so visual coverage needs no listener. */
describe.skipIf(!existsSync(executablePath))('Checks in both themes and widths', () => {
  beforeAll(async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    await mkdir(resolve('ui-shots'), { recursive: true });
    directory = await mkdtemp(resolve('.tmp/checks-ui-'));
    await build({
      stdin: { resolveDir: resolve('web/src'), sourcefile: 'checks-demo.tsx', loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import '@fontsource/figtree/latin-400.css';
        import '@fontsource/figtree/latin-600.css';
        import '@fontsource/young-serif/latin-400.css';
        import './tokens.css';
        import './styles.css';
        import './shell.css';
        import { ChecksSettingsPage } from './pages/SettingsChecks.js';
        import { setState } from './store.js';
        const params = new URLSearchParams(location.search);
        const phone = params.get('device') === 'phone';
        document.documentElement.dataset.theme = params.get('theme');
        setState(s => ({ ...s, device: { id: 'dv_000000000000000000000001', name: 'Example device', kind: phone ? 'phone' : 'desktop', scopes: phone ? ['settings'] : ['settings', 'pc-settings'], created: 0, lastSeen: 0 }, unpaired: false, sessionExpired: false }));
        const rows = [
          { id: 'hermes.always-revoked', state: 'fail', priority: 'high', sentence: 'A revoked entry is still loaded by the gateway.', details: ['Revoked entries: 1'], fix: { restart: { component: 'hermes', when: 'idle' } } },
          { id: 'hermes.approval-mode', state: 'warn', sentence: 'The saved approval mode differs from its intended setting.', details: ['approvals.mode'], fix: { operation: 'hermes.approval-mode', params: { mode: 'off' } } },
          { id: 'gateway.socket-unit', state: 'fail', sentence: 'The socket unit needs recovery.', details: ['gateway.socket-unit'], fix: { action: 'gateway.socket-recover' } },
          { id: 'hermes.managed', state: 'ok', sentence: 'The managed keys match their intended configuration.' },
          { id: 'windows-hermes.models', state: 'unknown', sentence: 'The source could not be read.', details: ['Source unavailable'] },
        ];
        const view = name => ({ ok: true, view: name, present: true, sha256: 'a'.repeat(64), values: [] });
        window.fetch = async url => {
          const path = String(url);
          if (path.endsWith('/api/settings/checks')) return Response.json({ generatedAt: Date.UTC(2026, 3, 14, 13, 30), rows });
          if (path.endsWith('/sections/checks')) return Response.json({ section: 'checks', views: [view('hermes.models'), view('gateway.state'), { ok: true, view: 'hermes.managed', present: false }], operations: [{ operation: 'gateway.socket-recover', title: 'Recover gateway role listeners', access: phone ? 'confirm' : 'editable' }] });
          return Response.json({ section: 'safety', views: [view('hermes.safety'), { ok: true, view: 'hermes.managed', present: false }], operations: [{ operation: 'hermes.approval-mode', title: 'Approval mode', access: phone ? 'read-only' : 'editable', accessByValue: { off: phone ? 'read-only' : 'editable' } }] });
        };
        createRoot(document.getElementById('root')).render(<ChecksSettingsPage />);
      ` },
      outfile: resolve(directory, 'demo.js'), bundle: true, format: 'iife',
      loader: { '.woff': 'file', '.woff2': 'file' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    await writeFile(resolve(directory, 'demo.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="demo.css"></head><body><div id="root"></div><script src="demo.js"></script></body></html>');
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  for (const device of ['phone', 'desktop'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      it(`${device}, ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width: device === 'phone' ? 390 : 1280, height: 1000 } });
        try {
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.route(/^https?:/, route => route.abort());
          await page.goto(pathToFileURL(resolve(directory, 'demo.html')).href + `?device=${device}&theme=${theme}`);
          await page.waitForSelector('[data-check-id="hermes.approval-mode"] button');
          await page.evaluate(() => document.fonts.ready);
          expect(errors).toEqual([]);
          expect(await page.locator('[data-check-id]').count()).toBe(5);
          expect(await page.locator('[data-check-id]').first().getAttribute('data-check-id')).toBe('hermes.always-revoked');
          expect(await page.getByRole('button', { name: 'Fix hermes.approval-mode' }).isDisabled()).toBe(device === 'phone');
          expect(await page.getByRole('button', { name: 'Fix gateway.socket-unit' }).isEnabled()).toBe(true);
          expect(await page.locator('.page-checks-settings').innerText()).not.toContain('This section is read-only');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: resolve('ui-shots', `checks-${device}-${theme}.png`), fullPage: true });
        } finally {
          await page.close();
        }
      });
    }
  }
});
