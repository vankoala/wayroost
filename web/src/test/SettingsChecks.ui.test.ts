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
        import { SafetySettingsPage } from './pages/SettingsSafety.js';
        import { ForYouSettings } from './components/ForYouSettings.js';
        import { NotificationRules } from './components/NotificationRules.js';
        import { RecentChanges } from './components/RecentChanges.js';
        import { setState } from './store.js';
        const params = new URLSearchParams(location.search);
        const phone = params.get('device') === 'phone';
        const rollout = { settingsPages: true, revokes: true, chatFirst: true };
        const initialRollout = params.get('rollout') === 'missing' ? undefined : { ...rollout,
          settingsPages: params.get('rollout') !== 'off', revokes: !['off', 'revokes-off'].includes(params.get('rollout')) };
        document.documentElement.dataset.theme = params.get('theme');
        setState(s => ({ ...s, rollout: initialRollout, device: { id: 'dv_000000000000000000000001', name: 'Example device', kind: phone ? 'phone' : 'desktop', scopes: phone ? ['settings'] : ['settings', 'pc-settings'], created: 0, lastSeen: 0 }, unpaired: false, sessionExpired: false }));
        window.setRollout = next => setState(s => ({ ...s, rollout: next }));
        window.writeRequests = [];
        const subscription = { endpoint: 'https://example.com/push/example',
          options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
          toJSON: () => ({ endpoint: 'https://example.com/push/example', keys: { p256dh: 'example-key', auth: 'example-auth' } }),
          unsubscribe: async () => true };
        const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => subscription } };
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: async () => registration, ready: Promise.resolve(registration) } });
        Object.defineProperty(window, 'Notification', { value: { permission: 'granted', requestPermission: async () => 'granted' } });
        Object.defineProperty(window, 'PushManager', { value: class {} });
        const rows = [
          { id: 'hermes.always-revoked', state: 'fail', priority: 'high', sentence: 'A revoked entry is still loaded by the gateway.', details: ['Revoked entries: 1'], fix: { restart: { component: 'hermes', when: 'idle' } } },
          { id: 'hermes.approval-mode', state: 'warn', sentence: 'The saved approval mode differs from its intended setting.', details: ['approvals.mode'], fix: { operation: 'hermes.approval-mode', params: { mode: 'off' } } },
          { id: 'gateway.socket-unit', state: 'fail', sentence: 'The socket unit needs recovery.', details: ['gateway.socket-unit'], fix: { action: 'gateway.socket-recover' } },
          { id: 'hermes.managed', state: 'ok', sentence: 'The managed keys match their intended configuration.' },
          { id: 'windows-hermes.models', state: 'unknown', sentence: 'The source could not be read.', details: ['Source unavailable'] },
        ];
        const view = name => ({ ok: true, view: name, present: true, sha256: 'a'.repeat(64), values: [] });
        window.fetch = async (url, init) => {
          const path = String(url);
          if (init?.method === 'POST') {
            window.writeRequests.push(path);
            if (path.endsWith('/api/push/test')) return Response.json({ sent: 1 });
            if (path.endsWith('/api/push/devices')) return Response.json({ devices: 1 });
            return Response.json({ status: 'refused', code: 'not_rolled_out' });
          }
          if (path.endsWith('/api/push/key')) return Response.json({ publicKey: 'AQID' });
          if (params.get('screen') === 'rollout') {
            if (path.endsWith('/api/settings/notifications')) return Response.json({ rules: [],
              quietHours: { start: '21:00', end: '07:00' }, pushAvailable: true, pushDevices: 1,
              push: { approvals: true, cards: false }, presence: 'active', timeZoneConfigured: false });
            if (path.endsWith('/api/feed')) return Response.json({ settings: { level: 'normal', pulseFound: true,
              quietHours: { start: '21:00', end: '07:00' }, pushAvailable: true, pushDevices: 1,
              push: { approvals: true, cards: false }, lessLike: [{ topic: 'Example topic', example: 'Example card', at: 0 }] } });
            if (path.endsWith('/sections/safety')) return Response.json({ section: 'safety', rollout,
              views: [ { ...view('hermes.safety'), values: [
                { path: ['approvals', 'mode'], exists: true, value: 'manual' },
                { path: ['command_allowlist'], exists: true, value: ['git status'] },
                { path: ['skills', 'write_approval'], exists: true, value: false },
              ] }, { ...view('hermes.allowlist'), values: [{ path: ['command_allowlist'], exists: true, value: ['git status'] }] },
                { ok: true, view: 'hermes.managed', present: false }, view('wayroost.settings') ],
              operations: ['hermes.approval-mode', 'hermes.revoke-always', 'hermes.skill-staging'].map(operation => ({ operation, title: operation, access: 'editable' })) });
            if (path.endsWith('/sections/agents')) return Response.json({ section: 'agents', rollout, views: [view('paseo.agents')], operations: [] });
            if (path.endsWith('/sections/overview')) return Response.json({ section: 'overview', rollout, changes: [{ id: 'ch_000000000000000000000001', at: 0,
              action: 'apply', operation: 'hermes.revoke-always', target: 'hermes-config', keys: [], level: 'anywhere', timing: [{ label: 'now' }], result: 'ok', undoable: true, undoAccess: 'editable' }] });
            if (path.endsWith('/api/worker-approvals')) return Response.json({ enabled: true, application: 'partial', choiceConfirmed: true,
              config: 'written', reload: 'applied', uncoveredProviders: [], limitations: [] });
            if (path.endsWith('/api/safety-commands')) return Response.json({ enabled: true, commands: ['status'] });
          }
          if (path.endsWith('/api/settings/checks')) return Response.json({ generatedAt: Date.UTC(2026, 3, 14, 13, 30), rows });
          if (path.endsWith('/sections/checks')) return Response.json({ section: 'checks', rollout, views: [view('hermes.models'), view('gateway.state'), { ok: true, view: 'hermes.managed', present: false }], operations: [{ operation: 'gateway.socket-recover', title: 'Recover gateway role listeners', access: phone ? 'confirm' : 'editable' }] });
          return Response.json({ section: 'safety', rollout, views: [view('hermes.safety'), { ok: true, view: 'hermes.managed', present: false }], operations: [{ operation: 'hermes.approval-mode', title: 'Approval mode', access: phone ? 'read-only' : 'editable', accessByValue: { off: phone ? 'read-only' : 'editable' } }] });
        };
        createRoot(document.getElementById('root')).render(params.get('screen') === 'rollout'
          ? <><SafetySettingsPage /><div className="page"><ForYouSettings /><NotificationRules /><RecentChanges /></div></> : <ChecksSettingsPage />);
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

  for (const width of [390, 1280]) {
    for (const theme of ['light', 'dark']) {
      it(`settings rollout at ${width}px, ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        try {
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.route(/^https?:/, route => route.abort());
          for (const rollout of ['on', 'off', 'missing', 'revokes-off']) {
            await page.goto(pathToFileURL(resolve(directory, 'demo.html')).href + `?screen=rollout&theme=${theme}&rollout=${rollout}`);
            const revoke = page.getByRole('button', { name: 'Revoke git status', exact: true });
            const staging = page.getByRole('switch', { name: 'Skill changes wait for your OK' });
            await revoke.waitFor();
            await page.locator('.foryou-settings').getByRole('switch', { name: 'Quiet hours', exact: true }).waitFor();
            await page.evaluate(() => document.fonts.ready);
            expect(await revoke.isDisabled()).toBe(rollout !== 'on');
            expect(await staging.isDisabled()).toBe(rollout !== 'on');
            expect(await page.getByRole('button', { name: 'Undo Revoke an "always" entry' }).isDisabled()).toBe(rollout !== 'on');
            for (const section of ['.foryou-settings', '.notification-rules']) {
              const group = page.locator(section);
              const device = group.getByRole('switch', { name: 'Notifications on this device', exact: true });
              await device.waitFor();
              expect(await device.isEnabled()).toBe(true);
              const test = group.getByRole('button', { name: 'Send a test', exact: true });
              expect(await test.isEnabled()).toBe(true);
              for (const control of await group.locator('button, select').all()) {
                const label = await control.getAttribute('aria-label');
                if (label === 'Notifications on this device' || (await control.textContent())?.trim() === 'Send a test') continue;
                if (label === 'Save notification rules') continue;
                expect(await control.isDisabled()).toBe(['off', 'missing'].includes(rollout));
              }
              await test.click();
              await device.click();
              await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', section + ' button[aria-label="Notifications on this device"]');
            }
            expect(await page.evaluate(() => (window as unknown as { writeRequests: string[] }).writeRequests)).toEqual([
              '/api/push/test', '/api/push/devices', '/api/push/test', '/api/push/devices',
            ]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            expect(errors).toEqual([]);
            await page.screenshot({ path: resolve('ui-shots', `rollout-${rollout}-${width}-${theme}.png`), fullPage: true });
            if (rollout === 'on') {
              await page.evaluate(() => (window as unknown as { setRollout: (next: unknown) => void }).setRollout({ settingsPages: true, revokes: false, chatFirst: false }));
              await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button[aria-label="Revoke git status"]')?.disabled);
              expect(await staging.isDisabled()).toBe(true);
              expect(await page.getByRole('button', { name: 'Undo Revoke an "always" entry' }).isDisabled()).toBe(true);
              expect(await page.evaluate(() => (window as unknown as { writeRequests: string[] }).writeRequests)).toHaveLength(4);
            }
          }
        } finally {
          await page.close();
        }
      });
    }
  }
});
