import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Devices } from '../src/devices.js';
import { parseConfig } from '../src/config.js';
import { EventHub } from '../src/hub.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';
import { FakeHermes, FakePaseo, seedDevices, apiHeaders, postHeaders, PHONE_COOKIE, DESKTOP_COOKIE } from './helpers.js';
import type { SettingsOptions } from '../src/settings/routes.js';
import { HERMES_PERSONALITIES, readViewValues } from '../../shared/settings-ops.js';
import { hermesSetting, isSettingsSectionPayload, settingAsStringList, viewEntries, type SettingsSectionPayload } from '../../web/src/settingsModel.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(settings: SettingsOptions = {}, local = false) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.tmp/settings-data-'));
  roots.push(root);
  seedDevices(root);
  const config = parseConfig({ rollout: { settingsPages: true, revokes: true, chatFirst: true }, stateDir: root, publicOrigin: 'https://wayroost.example.com',
    access: { teamDomain: 'https://testteam.cloudflareaccess.com', aud: 'test-aud-0123456789abcdef', allowedEmails: ['you@example.com'] },
    settings: { legacyRoutesViaPipeline: true }, localListener: { port: 8892, pcOnlyWrites: true }, origins: ['https://127.0.0.1:8892'] });
  const supervisor = new FakeSettingsSupervisor();
  supervisor.documents['gateway-role-map'] = { roles: { main: 'example-a', coder: 'example-b' }, backends: {
    'example-a': { servedName: 'demo-a', contextLength: 8192 }, 'example-b': { servedName: 'demo-b', contextLength: 8192 },
  } };
  supervisor.documents['paseo-config'] = { daemon: { agentProfiles: [{ id: 'example-profile', model: 'demo/demo-model' }] } };
  const app = await buildApp({ config, devices: new Devices(root), supervisor, settings, hub: new EventHub(),
    sources: { hermes: new FakeHermes(), paseo: new FakePaseo() }, logger: false,
    verifier: async () => ({ email: 'you@example.com', exp: 2_000_000_000 }) });
  app.addHook('onRequest', async request => { Object.defineProperty(request.raw.socket, 'localPort', { configurable: true, value: local ? 8892 : 8893 }); });
  apps.push(app);
  const section = async (name: string, phone = true): Promise<SettingsSectionPayload> => {
    const response = await app.inject({ url: `/api/settings/sections/${name}`, headers: apiHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }) });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const write = (operation: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, phone = true) => app.inject({ method: 'POST', url: '/api/settings/apply',
    headers: postHeaders('fake', { cookie: phone ? PHONE_COOKIE : DESKTOP_COOKIE }), payload: { operation, params, ...extra } });
  return { app, supervisor, section, write, root, config };
}

describe('settings data', () => {
  it('gives phones redacted backend choices and resolves their IDs through confirmation', async () => {
    const f = await fixture();
    const payload = await f.section('models');
    expect(payload.backendChoices).toEqual([{ id: digest('example-a').slice(0, 63), label: 'Backend 1', currentRoles: ['main'] }, { id: digest('example-b').slice(0, 63), label: 'Backend 2', currentRoles: ['coder'] }]);
    expect(JSON.stringify(payload)).not.toContain('example-a');
    const params = { role: 'coder', backend: payload.backendChoices![0]!.id };
    const expected = { file: { sha256: payload.views!.find(view => view.view === 'gateway.role-map')!.sha256 } };
    const first = (await f.write('gateway.point', params, { expected })).json();
    expect(first.status).toBe('confirm');
    const result = (await f.write('gateway.point', params, { expected, confirm: first.confirm })).json();
    expect(result.status).toBe('applied');
    expect(f.supervisor.configApply).toHaveBeenCalledWith(expect.objectContaining({ params: { role: 'coder', backend: 'example-a' } }));
  });

  it('rejects a stale displayed hash even after missing all change events', async () => {
    const f = await fixture();
    const payload = await f.section('agents');
    const expected = { file: { sha256: payload.views!.find(view => view.view === 'hermes.agents')!.sha256 } };
    f.supervisor.documents['hermes-config']!.agent = { reasoning_effort: 'high' };
    const result = (await f.write('hermes.reasoning-effort', { effort: 'low' }, { expected })).json();
    expect(result).toMatchObject({ status: 'refused', code: 'precondition_changed' });
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
  });

  it('projects per-entry allowlist hashes, keeps commands hidden, and revokes from a phone', async () => {
    const f = await fixture();
    const payload = await f.section('safety');
    expect(payload.allowlistEntries).toEqual([{ entrySha256: digest('echo example') }]);
    expect(JSON.stringify(payload)).not.toContain('echo example');
    const result = (await f.write('hermes.revoke-always', { entrySha256: payload.allowlistEntries![0]!.entrySha256 }, { expected: { file: { sha256: payload.views!.find(view => view.view === 'hermes.safety')!.sha256 } } })).json();
    expect(result.status).toBe('applied');
    const overview = await f.section('overview');
    expect(overview.changes![0]).toMatchObject({ undoable: true, level: 'anywhere', undoAccess: 'read-only' });
  });

  it('hashes persisted variable expressions for revocation while retaining the effective safety view', async () => {
    const f = await fixture();
    f.supervisor.documents['hermes-config']!.command_allowlist = ['echo ${EXAMPLE_PATH}', 'echo keep'];
    f.supervisor.effectiveDocuments['hermes-config'] = { ...f.supervisor.documents['hermes-config'],
      command_allowlist: ['echo /tmp/example', 'echo keep'] };
    const payload = await f.section('safety');
    expect(payload.allowlistEntries).toEqual([{ entrySha256: digest('echo ${EXAMPLE_PATH}') }, { entrySha256: digest('echo keep') }]);
    expect(JSON.stringify(payload)).not.toMatch(/EXAMPLE_PATH|echo \/tmp\/example/);
    const result = (await f.write('hermes.revoke-always', { entrySha256: payload.allowlistEntries![0]!.entrySha256 },
      { expected: { file: { sha256: payload.views!.find(view => view.view === 'hermes.allowlist')!.sha256 } } })).json();
    expect(result.status).toBe('applied');
    expect(f.supervisor.documents['hermes-config']!.command_allowlist).toEqual(['echo keep']);
  });

  it('leaves dependent rows unavailable when the effective runtime cannot load', async () => {
    const f = await fixture();
    const read = f.supervisor.configRead.getMockImplementation()!;
    f.supervisor.configRead.mockImplementation(async request => request.view.startsWith('hermes.') && request.view !== 'hermes.allowlist'
      ? { ok: false, code: 'unavailable' } as never : read(request));
    const safety = await f.section('safety');
    expect(safety.views).toEqual(expect.arrayContaining([{ ok: false, view: 'hermes.safety', code: 'unavailable' }]));
    expect(safety.allowlistEntries).toBeUndefined();
    expect((await f.section('models')).views).toEqual(expect.arrayContaining([{ ok: false, view: 'hermes.models', code: 'unavailable' }]));
    expect((await f.write('hermes.approval-mode', { mode: 'manual' })).json()).toMatchObject({ status: 'refused', code: 'unavailable' });
    expect(f.supervisor.configApply).not.toHaveBeenCalled();
  });

  it('keeps effective commands on the safety view and persisted text on the editing view', async () => {
    const f = await fixture({}, true);
    f.supervisor.documents['hermes-config']!.command_allowlist = '["echo ${EXAMPLE_PATH}", "echo keep"]';
    f.supervisor.effectiveDocuments['hermes-config'] = { ...f.supervisor.documents['hermes-config'],
      command_allowlist: ['echo /tmp/example', 'echo keep'] };
    const payload = await f.section('safety', false);
    const entries = viewEntries(payload, 'hermes.safety').entries;
    expect(entries.get('command_allowlist')).toMatchObject({ exists: true, value: ['echo /tmp/example', 'echo keep'] });
    expect(viewEntries(payload, 'hermes.allowlist').entries.get('command_allowlist')).toMatchObject({ exists: true,
      value: '["echo ${EXAMPLE_PATH}", "echo keep"]' });
    expect(settingAsStringList(hermesSetting(payload, 'hermes.safety', 'command_allowlist', payload).value))
      .toEqual(['echo ${EXAMPLE_PATH}', 'echo keep']);
    expect((await f.write('hermes.revoke-always', { entrySha256: digest('echo ${EXAMPLE_PATH}') }, {}, false)).json().status).toBe('applied');
    expect(f.supervisor.documents['hermes-config']!.command_allowlist).toEqual(['echo keep']);
  });

  it.each([true, false])('preserves a managed effective command when the user file is present: %s', async present => {
    const f = await fixture({}, true);
    delete f.supervisor.documents['hermes-config']!.command_allowlist;
    const read = f.supervisor.configRead.getMockImplementation()!;
    f.supervisor.configRead.mockImplementation(async request => request.view === 'hermes.safety'
      ? { ok: true, view: request.view, present, effective: true, ...(present ? { sha256: f.supervisor.sha('hermes-config') } : {}),
        values: [{ path: ['command_allowlist'], exists: true, value: ['echo managed-example'] }] } as never
      : request.view === 'hermes.allowlist' && !present ? { ok: true, view: request.view, present: false, values: [] } as never : read(request));
    const payload = await f.section('safety', false);
    expect(payload.views!.find(view => view.view === 'hermes.safety')).toMatchObject({ ok: true, present, effective: true });
    expect(viewEntries(payload, 'hermes.safety').entries.get('command_allowlist')).toMatchObject({ exists: true, value: ['echo managed-example'] });
    expect(viewEntries(payload, 'hermes.allowlist').entries.get('command_allowlist')?.exists ?? false).toBe(false);
    expect(payload.allowlistEntries).toEqual([]);
    expect(JSON.stringify(await f.section('safety'))).not.toContain('echo managed-example');
  });

  it('returns built-in and custom personality names without their definitions', async () => {
    const f = await fixture({}, true);
    f.supervisor.documents['hermes-config']!.agent = { personalities: { 'example-persona': 'Example overlay text' } };
    const local = await f.section('agents', false);
    expect(local.personalities?.map(entry => entry.id)).toEqual(expect.arrayContaining([...HERMES_PERSONALITIES, 'example-persona']));
    expect(JSON.stringify(local)).not.toContain('Example overlay text');
    const phone = await f.section('agents');
    expect(JSON.stringify(phone)).not.toContain('example-persona');
    const custom = phone.personalities!.find(entry => entry.id === digest('example-persona'))!;
    expect(custom).toBeTruthy();
    expect((await f.write('hermes.personality', { personality: custom.id })).json().status).toBe('applied');
    expect(f.supervisor.documents['hermes-config']!.display).toEqual({ personality: 'example-persona' });
  });

  it('projects actual profile arrays with opaque phone identities', async () => {
    const f = await fixture({}, true);
    const local = await f.section('agents', false);
    expect(local.profiles).toEqual([{ id: 'example-profile', label: 'example-profile', model: 'demo/demo-model' }]);
    const phone = await f.section('agents');
    expect(phone.profiles).toEqual([{ id: digest('example-profile'), label: 'Profile 1' }]);
    const result = (await f.write('paseo.profile-model', { profile: phone.profiles![0]!.id, model: 'demo/demo-new' })).json();
    expect(result.status).toBe('confirm');
  });

  it('sanitizes live status, role-load measurements and explicit installation metadata', async () => {
    const f = await fixture({ modelStatus: async () => [{ role: 'main', health: 'up', inFlight: 2, backendPort: 1, privateDetail: 'hidden' }],
      roleLoads: async () => [{ role: 'example-role', harness: 'hermes', words: 20, tokens: 30, targetWords: 40, budgetWords: 50, parts: { shared: 5, dispatch: 5, role: 5, skills: 5 }, privateDetail: 'hidden' }],
      agentAvailability: async () => [{ id: 'codex', installed: true, authenticated: false, privateDetail: 'hidden' }] });
    expect((await f.section('models')).modelStatus).toEqual([{ role: 'main', health: 'up', inFlight: 2 }]);
    const agents = await f.section('agents');
    expect(agents.roleLoads?.[0]).toMatchObject({ role: 'example-role', budgetWords: 50 });
    expect(agents.agentAvailability).toEqual([{ id: 'codex', installed: true, authenticated: false }]);
    expect(JSON.stringify(agents)).not.toContain('privateDetail');
  });
  it('wires production readers into pages without injected settings reader hooks', async () => {
    const f = await fixture();
    f.supervisor.agentAvailability = [{ id: 'claude', installed: true, authenticated: true },
      { id: 'codex', installed: true, authenticated: false }, { id: 'copilot', installed: false, authenticated: null }];
    const original = f.supervisor.configRead.getMockImplementation()!;
    const contract = { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 4096, advertisedContext: 32768 };
    f.supervisor.configRead.mockImplementation(async request => request.view === 'gateway.status' ? { ok: true, view: request.view,
      present: true, sha256: 'a'.repeat(64), values: [{ path: ['roles'], exists: true, value: Object.fromEntries(['main', 'coder', 'fast'].map(role => [role, {
        backend: 'example', backendModel: 'example-model', contextLength: 32768, contract, health: 'up', backendPort: 19041, inFlight: 2, openConnections: 3,
      }])) }, { path: ['draining'], exists: true, value: false }],
    } as never : original(request));
    writeFileSync(resolve(f.root, 'roles-pack-build.json'), JSON.stringify({ loads: [{ roleId: 'example-role', harness: 'hermes', words: 20, tokens: 27,
      targetWords: 4000, budgetWords: 100, parts: [{ name: 'shared rules', words: 5 }, { name: 'dispatch protocol', words: 5 }, { name: 'role section', words: 10 }] }] }));
    const models = await f.section('models');
    expect(models.modelStatus).toEqual(['main', 'coder', 'fast'].map(role => ({ role, health: 'up', inFlight: 2 })));
    const agents = await f.section('agents');
    expect(agents.roleLoads).toEqual([{ role: 'example-role', harness: 'hermes', words: 20, tokens: 27, targetWords: 4000, budgetWords: 100,
      parts: { shared: 5, dispatch: 5, role: 10, skills: 0 } }]);
    expect(agents.agentAvailability).toEqual(f.supervisor.agentAvailability);
    expect(f.supervisor.configRead).toHaveBeenCalledWith({ view: 'wayroost.agents' });
    expect(JSON.stringify(models.modelStatus)).not.toMatch(/example-model|19041/);
  });
  it('shows scalar allowlist entries as hashes and observes the normalized revoke', async () => {
    const f = await fixture();
    f.supervisor.documents['hermes-config']!.command_allowlist = '["echo example", "echo keep"]';
    expect((await f.section('safety')).allowlistEntries).toEqual([{ entrySha256: digest('echo example') }, { entrySha256: digest('echo keep') }]);
    const result = await f.write('hermes.revoke-always', { entrySha256: digest('echo example') });
    expect(result.json().status).toBe('applied');
    expect(f.supervisor.documents['hermes-config']!.command_allowlist).toEqual(['echo keep']);
  });

  it('does not manufacture live numbers or measurements when readers fail', async () => {
    const f = await fixture({ modelStatus: async () => { throw new Error('unavailable'); }, roleLoads: async () => [{ words: -1 }] });
    expect((await f.section('models')).modelStatus).toBeUndefined();
    expect((await f.section('agents')).roleLoads).toBeUndefined();
  });

  it('keeps the failing view identity so pages can render its error', async () => {
    const f = await fixture();
    f.supervisor.configRead.mockResolvedValue({ ok: false, code: 'unavailable' } as never);
    expect((await f.section('models')).views).toEqual(expect.arrayContaining([{ ok: false, view: 'gateway.role-map', code: 'unavailable' }]));
  });
  it('projects effective defaults without a persisted file and renders their permitted values', async () => {
    const f = await fixture();
    const values = await readViewValues('hermes.models', { model: { default: 'example-private-model', provider: 'example-private-provider' } },
      { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
    f.supervisor.configRead.mockResolvedValue({ ok: true, view: 'hermes.models', present: false, effective: true, values } as never);
    const payload = await f.section('agents');
    expect(isSettingsSectionPayload(payload, 'agents')).toBe(true);
    const rendered = viewEntries(payload, 'hermes.models');
    expect(rendered.absent).toBe(false);
    expect(rendered.entries.get('model.default')).toMatchObject({ exists: true, value: { sha256: expect.any(String) } });
    expect(JSON.stringify(payload)).not.toMatch(/example-private-model|example-private-provider/);
  });

  it('keeps custom personality values hidden even in the shared PC projector', async () => {
    const result = await readViewValues('hermes.agents', { personalities: { 'example-name': 'Example overlay' } }, { scopes: ['settings', 'pc-settings'], listener: 'local', pcOnlyWrites: true });
    expect(result.find(entry => entry.path[0] === 'personalities')).toEqual({ path: ['personalities', 'example-name'], exists: true });
  });
});

describe('settings visual checks', () => {
  it('uses separate loopback hosts within the assigned port pair', () => {
    const source = readFileSync(resolve('scripts/ui-check.ts'), 'utf8');
    expect(source).toContain('const APP_PORT = PORT + 1;');
    expect(source).toContain('const LOCAL_PORT = PORT;');
    expect(source).toContain('http://127.0.0.2:${LOCAL_PORT}');
    expect(source).not.toContain('const LOCAL_PORT = PORT + 4');
  });

  it('covers each settings page at both widths in both themes', () => {
    const source = readFileSync(resolve('scripts/ui-check.ts'), 'utf8');
    const remaining = source.slice(source.indexOf('const remainingSettingsShots = ['), source.indexOf('] as const;', source.indexOf('const remainingSettingsShots = [')));
    const initial: Record<string, string[]> = { agents: ['desktop-light', 'phone-dark'], models: ['desktop-dark', 'phone-light'], safety: ['desktop-light', 'phone-dark'], recent: ['desktop-light'] };
    for (const [page, combinations] of Object.entries(initial)) {
      const entries = [...remaining.matchAll(/page: '([^']+)', width: '([^']+)', dark: (true|false)/g)].filter(match => match[1] === page).map(match => `${match[2]}-${match[3] === 'true' ? 'dark' : 'light'}`);
      expect([...combinations, ...entries].sort()).toEqual(['desktop-dark', 'desktop-light', 'phone-dark', 'phone-light']);
    }
    expect(source).toContain('110-phone-model-confirm-');
    expect(source).toContain('Undo of Reasoning effort');
  });

  it('uses defined surface, depth and font tokens for the confirmation card', () => {
    const styles = readFileSync(resolve('web/src/styles.css'), 'utf8');
    const card = [...styles.matchAll(/\.confirm-card \{([^}]+)\}/g)].at(-1)![1]!;
    expect(card).toContain('background: var(--surface);');
    expect(card).toContain('box-shadow: var(--shadow-card);');
    expect(card).not.toMatch(/rgba|--card-bg|--panel/);
    const introduced = styles.slice(styles.indexOf('/* ── Settings pages'));
    expect(introduced).not.toMatch(/rgba\(|#[a-f0-9]{3,8}\b|var\(--panel\)|var\(--mono[,)]/i);
  });
});
