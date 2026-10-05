import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { productionSettingsReaders } from '../src/settings/readers.js';
import { readAgentAvailability } from '../../supervisor/src/config-observations.js';
import { parseConfig } from '../src/config.js';
import { FakeSettingsSupervisor } from './fake-settings-supervisor.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const base = join(process.cwd(), '.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'settings-readers-')); roots.push(root); return root;
}
async function program(root: string, name: string, source: string) {
  const path = join(root, name); await writeFile(path, `#!${process.execPath}\n${source}`); await chmod(path, 0o700); return path;
}

it('uses supervisor observations for every role without forwarding backend metadata', async () => {
  const supervisor = new FakeSettingsSupervisor();
  const contract = { input: ['text'], toolCalling: true, thinkingLevels: false, maxOutputTokens: 4096, advertisedContext: 32768 };
  const roles = Object.fromEntries(['main', 'coder', 'fast'].map((role, index) => [role, {
    backend: 'example', backendModel: 'example-model', contextLength: 32768, contract,
    health: ['up', 'owner_mismatch', 'unknown'][index], backendPort: 19041, inFlight: index + 1, openConnections: 5,
  }]));
  supervisor.configRead.mockResolvedValue({ ok: true, view: 'gateway.status', present: true, sha256: 'a'.repeat(64), values: [
    { path: ['roles'], exists: true, value: roles as never }, { path: ['draining'], exists: true, value: false },
  ] } as never);
  const readers = productionSettingsReaders(parseConfig({ publicOrigin: 'https://example.com', stateDir: await fixture() }), supervisor);
  expect(await readers.modelStatus!()).toEqual([
    { role: 'main', health: 'up', inFlight: 1 }, { role: 'coder', health: 'owner_mismatch', inFlight: 2 }, { role: 'fast', health: 'unknown', inFlight: 3 },
  ]);
  expect(supervisor.configRead).toHaveBeenCalledWith({ view: 'gateway.status' });
  supervisor.configRead.mockResolvedValue({ ok: false, code: 'unavailable' } as never);
  await expect(readers.modelStatus!()).rejects.toThrow('unavailable');
});

it('keeps installation and authentication independent and excludes raw status output', async () => {
  const config = { home: '/home/me', binaries: { claude: '/example/claude', codex: '/example/codex', copilot: '/example/copilot' } };
  const command = vi.fn(async (path: string, args: string[]) => {
    if (args[0] === '--version') return { code: 0, stdout: 'example version', stderr: '' };
    return path.endsWith('claude') ? { code: 0, stdout: JSON.stringify({ loggedIn: true, email: 'you@example.com', token: 'obviously-fake' }), stderr: '' }
      : { code: 1, stdout: '', stderr: 'Not logged in\n' };
  });
  const copilot = vi.fn(async () => false);
  const result = await readAgentAvailability(config, { command, copilot });
  expect(result).toEqual([{ id: 'claude', installed: true, authenticated: true }, { id: 'codex', installed: true, authenticated: false },
    { id: 'copilot', installed: true, authenticated: false }]);
  expect(command.mock.calls.map(call => call.slice(0, 2))).toContainEqual(['/example/claude', ['auth', 'status', '--json']]);
  expect(command.mock.calls.map(call => call.slice(0, 2))).toContainEqual(['/example/codex', ['login', 'status']]);
  expect(copilot).toHaveBeenCalledWith('/example/copilot', '/home/me');
  expect(JSON.stringify(result)).not.toMatch(/you@example.com|obviously-fake/);
});

it('reads real bounded status commands and the Copilot stdio RPC with temporary programs', async () => {
  const root = await fixture();
  const claude = await program(root, 'example-claude', `process.stdout.write(process.argv[2] === '--version' ? 'example' : '{"loggedIn":false,"email":"you@example.com"}');`);
  const codex = await program(root, 'example-codex', `process.stderr.write(process.argv[2] === '--version' ? '' : 'Logged in using ChatGPT\\n');`);
  const copilot = await program(root, 'example-copilot', `
if (process.argv.includes('--version')) process.stdout.write('example');
else {
  if (!process.argv.includes('--stdio') || !process.argv.includes('--no-auto-update')) process.exit(1);
  process.stdin.once('data', chunk => {
    if (!chunk.toString().includes('auth.getStatus')) process.exit(1);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isAuthenticated: true, login: 'example-user' } });
    const response = 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body;
    process.stdout.write(response.slice(0, 10));
    setTimeout(() => process.stdout.write(response.slice(10)), 10);
  });
}`);
  expect(await readAgentAvailability({ home: root, binaries: { claude, codex, copilot } })).toEqual([
    { id: 'claude', installed: true, authenticated: false }, { id: 'codex', installed: true, authenticated: true },
    { id: 'copilot', installed: true, authenticated: true },
  ]);
});

it('distinguishes missing installations from malformed or failed sign-in probes', async () => {
  const root = await fixture();
  const broken = await program(root, 'example-broken', `process.stdout.write(process.argv[2] === '--version' ? 'example' : 'unexpected status');`);
  const result = await readAgentAvailability({ home: root, binaries: { claude: join(root, 'missing'), codex: broken } });
  expect(result).toEqual([{ id: 'claude', installed: false, authenticated: null }, { id: 'codex', installed: true, authenticated: null },
    { id: 'copilot', installed: null, authenticated: null }]);
});

it('bounds stalled status commands and oversized authentication output', async () => {
  const root = await fixture();
  const claude = await program(root, 'example-stalled', `
if (process.argv[2] === '--version') process.stdout.write('example');
else { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
`);
  const codex = await program(root, 'example-oversized', `
process.stdout.write(process.argv[2] === '--version' ? 'example' : 'x'.repeat(17 * 1024));
`);
  expect(await readAgentAvailability({ home: root, binaries: { claude, codex } })).toEqual([
    { id: 'claude', installed: true, authenticated: null }, { id: 'codex', installed: true, authenticated: null },
    { id: 'copilot', installed: null, authenticated: null },
  ]);
});

it('fails closed on oversized compiler measurements and inconsistent measured totals', async () => {
  const root = await fixture(); const path = join(root, 'build.json');
  const readers = productionSettingsReaders(parseConfig({ publicOrigin: 'https://example.com', stateDir: root, settings: { packBuildFile: path } }));
  await writeFile(path, JSON.stringify({ loads: [{ roleId: 'example-role', harness: 'hermes', words: 10, tokens: 14, targetWords: 4000, budgetWords: null, parts: [] }] }));
  await expect(readers.roleLoads!()).rejects.toThrow();
  await writeFile(path, 'x'.repeat(4 * 1024 * 1024 + 1));
  await expect(readers.roleLoads!()).rejects.toThrow('unavailable');
});


it('reads agent availability exclusively through the supervisor while the server home is isolated', async () => {
  const root = await fixture();
  const supervisor = new FakeSettingsSupervisor();
  const agents = [{ id: 'claude', installed: true, authenticated: true }, { id: 'codex', installed: true, authenticated: false },
    { id: 'copilot', installed: false, authenticated: null }];
  supervisor.configRead.mockResolvedValue({ ok: true, view: 'wayroost.agents', present: true, sha256: 'a'.repeat(64),
    values: [{ path: ['agents'], exists: true, value: agents }] } as never);
  const readers = productionSettingsReaders(parseConfig({ publicOrigin: 'https://example.com', stateDir: root }), supervisor);
  expect(await readers.agentAvailability!()).toEqual(agents);
  expect(supervisor.configRead).toHaveBeenCalledWith({ view: 'wayroost.agents' });
  const { readFile } = await import('node:fs/promises');
  const unit = await readFile(join(process.cwd(), 'deploy/wayroost-server.service'), 'utf8');
  expect(unit).toContain('DynamicUser=yes'); expect(unit).toContain('ProtectHome=yes');
  const source = await readFile(join(process.cwd(), 'server/src/settings/readers.ts'), 'utf8');
  expect(source).not.toContain('node:child_process');
  supervisor.configRead.mockResolvedValue({ ok: false, code: 'not_configured' } as never);
  await expect(readers.agentAvailability!()).rejects.toThrow('unavailable');
});

it('refuses agent availability replies with identities or unexpected flags', async () => {
  const supervisor = new FakeSettingsSupervisor();
  supervisor.configRead.mockResolvedValue({ ok: true, view: 'wayroost.agents', present: true, sha256: 'a'.repeat(64), values: [
    { path: ['agents'], exists: true, value: [{ id: 'claude', installed: true, authenticated: true, email: 'you@example.com' }] },
  ] } as never);
  const readers = productionSettingsReaders(parseConfig({ publicOrigin: 'https://example.com', stateDir: await fixture() }), supervisor);
  await expect(readers.agentAvailability!()).rejects.toThrow();
});
