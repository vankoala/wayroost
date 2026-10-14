import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { hostPaths } from './host-path-fixture.js';
import { BackgroundGate } from '../src/background.js';
import { configPath, loadStartupConfig, parseConfig } from '../src/config.js';
import { blockedReason, catalogCommands, parseSlash } from '../src/hermes/commands.js';
import { readOrCreateClientId } from '../src/secrets.js';

function documentText(name: string): string {
  return readFileSync(new URL(`../../docs/${name}.md`, import.meta.url), 'utf8');
}

function primaryDefaults() {
  const example = documentText('configuration').split('## Fields')[0]!.match(/```json\n([\s\S]*?)\n```/);
  const { stateDir: _stateDir, ...input } = JSON.parse(example![1]!) as Record<string, unknown>;
  return parseConfig(input, { env: {} });
}

it('loads the documented primary config without development overrides', () => {
  const document = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
  const example = document.split('## Fields')[0]!.match(/```json\n([\s\S]*?)\n```/);
  expect(example).not.toBeNull();
  const directory = mkdtempSync(fileURLToPath(new URL('./.config-example-', import.meta.url)));
  try {
    const path = join(directory, 'config.json');
    writeFileSync(path, example![1]!);
    const config = loadStartupConfig(path, {});
    expect(config.role).toBe('primary');
    expect(config.publicOrigin).toBe('https://wayroost.example.com');
    expect(config.devices.enabled).toBe(true);
    expect(config.settings.legacyRoutesViaPipeline).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('pins the documented DNS route to an explicit config and tunnel UUID', () => {
  const document = readFileSync(new URL('../../docs/shadow-cutover.md', import.meta.url), 'utf8');
  const command = document.match(/sudo -H cloudflared [^\n`]+/)?.[0];
  expect(command).toBeDefined();
  const example = command!
    .replace('<tunnel-config.yml>', '/home/me/wayroost-tunnel.yml')
    .replace('<tunnel-uuid>', '00000000-0000-0000-0000-000000000001')
    .replace('<tunnel-name>', 'wayroost')
    .replace('<hostname>', 'wayroost.example.com');
  const output = execFileSync('bash', ['--noprofile', '--norc', '-c', `sudo() { printf '%s\\n' "$@"; }\n${example}`], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000,
  });
  expect(output.trim().split('\n')).toEqual([
    '-H', 'cloudflared', 'tunnel', '--config', '/home/me/wayroost-tunnel.yml',
    'route', 'dns', '00000000-0000-0000-0000-000000000001', 'wayroost.example.com',
  ]);
});

it('uses the documented owner address file for Hermes launch reports on a custom bridge port', () => {
  const document = readFileSync(new URL('../../docs/bridge.md', import.meta.url), 'utf8');
  const example = [...document.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map(match => match[1]!).find(block => block.includes('/bridge-url'));
  expect(example).toBeDefined();
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.tmp', 'documented-bridge-'));
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-e', '-u', '-c', example!.replaceAll('$HOME', '$OWNER_HOME')], {
      env: { PATH: '/usr/bin:/bin', OWNER_HOME: directory }, timeout: 5_000,
    });
    const address = join(directory, '.config/wayroost/bridge-url');
    expect(readFileSync(address, 'ascii').trim()).toBe('http://127.0.0.1:19112');
    expect(statSync(join(directory, '.config/wayroost')).mode & 0o777).toBe(0o700);
    expect(statSync(address).mode & 0o777).toBe(0o600);
    const output = execFileSync('python3', ['-I', '-B', '-c', String.raw`
import importlib.util, sys
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("demo_identity", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
opener = Mock()
opener.open.return_value.__enter__ = Mock(return_value=Mock())
opener.open.return_value.__exit__ = Mock(return_value=False)
with patch.object(Path, "home", return_value=Path(sys.argv[2])), \
     patch.object(plugin, "_bridge_token", return_value="obviously_fake_token_" * 3), \
     patch("urllib.request.build_opener", return_value=opener):
    plugin._post("note_launch", {"child": "00000000_000000_fake", "candidates": []})
print(opener.open.call_args.args[0].full_url)
`, fileURLToPath(new URL('../../hermes-plugin/wayroost-identity/__init__.py', import.meta.url)), directory], {
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5_000,
    });
    expect(output.trim()).toBe('http://127.0.0.1:19112/bridge/v1/note_launch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('documents the root test suites and desktop exclusions from the test config', async () => {
  const configUrl = new URL('../../vitest.config.ts', import.meta.url).href;
  const { desktopOnly, default: config } = await import(configUrl) as {
    desktopOnly: string[];
    default: { test: { include?: string[]; projects?: Array<{ test: { include: string[] } }> } };
  };
  const includes = config.test.include ?? config.test.projects!.flatMap(project => project.test.include);
  const section = documentText('development').split('## Tests')[1]!.split('| Suite')[0]!;
  const paths = [...section.trim().split('\n\n')[0]!.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
  expect(paths.filter(path => path.endsWith('/')).sort()).toEqual(includes.map(glob => glob.replace('/**/*.test.ts', '/')).sort());
  expect(paths.filter(path => path.startsWith('desktop/test/') && path.endsWith('.test.ts')).sort()).toEqual([...desktopOnly].sort());
  expect(section.replace(/\s+/g, ' ')).toContain("desktop package's own dependencies");
});

it('documents the primary state directory used by the config parser', () => {
  const host = documentText('how-it-works').split('## The host')[1]!;
  expect(host).toContain(`\`${primaryDefaults().stateDir}\``);
  expect(host).not.toContain(`\`${hostPaths.legacyState}\``);
});

it('documents both settings states for Hermes command restrictions and menu visibility', () => {
  const section = documentText('hermes').split('### Blocked commands')[1]!.split('## Connectors')[0]!;
  const text = section.replace(/\s+/g, ' ');
  expect(text).toContain('**Settings → Safety → Hermes safety commands** is off (the default)');
  expect(text).toMatch(/Turning it on allows every form.*restores.*menu/);
  const forms = [...section.matchAll(/^\| `([^`]+)`(?:, `([^`]+)`)? \|/gm)]
    .flatMap(match => [match[1]!, ...(match[2] ? [match[2]] : [])]);
  expect(forms).toHaveLength(7);
  const names = new Set<string>();
  for (const form of forms) {
    const cmd = parseSlash(form.replace('<mode>', 'off').replace('…', ' off'))!;
    expect(blockedReason(cmd)).not.toBeNull();
    expect(blockedReason(cmd, true)).toBeNull();
    names.add(cmd.name);
  }
  const catalog = { categories: [{ name: 'Commands', pairs: [...names].map(name => [`/${name}`, name]) }] };
  expect(catalogCommands(catalog)).toEqual([]);
  expect(catalogCommands(catalog, { allowSafety: true }).map(cmd => cmd.name)).toEqual([...names]);
});

it('quotes the current Hermes command refusal message', () => {
  const section = documentText('hermes').split('### Blocked commands')[1]!.split('## Connectors')[0]!.replace(/\s+/g, ' ');
  const example = section.match(/such as "([^"]+)"/)?.[1];
  expect(example).toBe(blockedReason({ name: 'yolo', arg: '' }));
});

it('documents the Paseo client id in the configured state directory', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.tmp', 'documented-client-'));
  try {
    const id = readOrCreateClientId(directory, new BackgroundGate('primary'));
    expect(readOrCreateClientId(directory)).toBe(id);
    const files = readdirSync(directory);
    expect(files).toEqual(['paseo-client-id']);
    const section = documentText('paseo').split('## Connecting')[1]!.split('## The inbox')[0]!;
    expect(section).toContain('`<stateDir>/paseo-client-id`');
    expect(section).toContain(`\`${join(primaryDefaults().stateDir, files[0]!)}\``);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('documents temporary client ids and reuse of saved ids in shadow mode', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), '.tmp', 'documented-shadow-client-'));
  try {
    const id = readOrCreateClientId(directory, new BackgroundGate('shadow'));
    expect(id).toMatch(/^cid_[a-z0-9_]{8,64}$/);
    expect(readdirSync(directory)).toEqual([]);
    expect(readOrCreateClientId(directory, new BackgroundGate('shadow'))).not.toBe(id);
    expect(readdirSync(directory)).toEqual([]);

    const savedId = 'cid_obviously_fake_saved_id';
    writeFileSync(join(directory, 'paseo-client-id'), savedId);
    expect(readOrCreateClientId(directory, new BackgroundGate('shadow'))).toBe(savedId);
    expect(readFileSync(join(directory, 'paseo-client-id'), 'utf8')).toBe(savedId);

    const section = documentText('paseo').split('## Connecting')[1]!.split('## The inbox')[0]!.replace(/\s+/g, ' ');
    expect(section).toContain('Shadow mode reuses an existing saved id');
    expect(section).toContain('creates no client-id file');
    expect(section).toContain('keeps a newly generated id only for that process');
    expect(section).toContain('A restart generates a new id');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('documents the Paseo password credential in the installed server unit', () => {
  const installer = readFileSync(new URL('../../deploy/install-wayroost-server.sh', import.meta.url), 'utf8');
  const passwordFile = installer.match(/^PASSWORD_FILE=(\S+)/m)?.[1];
  const credential = installer.match(/PASSWORD_CREDENTIAL="(LoadCredential=[^"]+)"/)?.[1];
  const service = installer.match(/^install_unit (\S+) "\$SERVER_UNIT"/m)?.[1];
  expect(passwordFile).toBeDefined();
  expect(credential).toBeDefined();
  expect(service).toBeDefined();
  const section = documentText('paseo').split('## Connecting')[1]!.split('## The inbox')[0]!;
  expect(section).toContain(`\`${credential!.replace('$PASSWORD_FILE', passwordFile!)}\``);
  expect(section).toContain(`\`${service}.service\``);
  expect(section).not.toContain('signalbox.service.d');
});

it('documents the startup config variable, default path and deprecated fallback', () => {
  const row = documentText('signalbox').match(/^\| `npm start` \| ([^\n]+) \|$/m)?.[1];
  expect(row).toBeDefined();
  expect(row).toContain('config at `WAYROOST_CONFIG`');
  expect(row).toContain(`default \`${configPath({})}\``);
  expect(row).toMatch(/`SIGNALBOX_CONFIG`.*deprecated fallback/);
  expect(configPath({ WAYROOST_CONFIG: '/home/me/primary.json', SIGNALBOX_CONFIG: '/home/me/legacy.json' })).toBe('/home/me/primary.json');
  expect(configPath({ SIGNALBOX_CONFIG: '/home/me/legacy.json' })).toBe('/home/me/legacy.json');
});
