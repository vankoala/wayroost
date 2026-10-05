import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from './legacy-config.js';
import { hashKey, loadKeys } from './legacy-keys.js';
import { loadConfig as currentConfig } from '../src/config.js';
import { loadKeys as currentKeys } from '../src/keys.js';

it('loads the keys and supervisor configuration with the previous release\'s strict parsers', async () => {
  const root = await mkdtemp(join(process.cwd(), '.config-rollback-test-'));
  try {
    const keys = join(root, 'supervisor-keys.json'); const config = join(root, 'supervisor.json'); const site = join(root, 'settings-targets.json');
    await writeFile(keys, JSON.stringify([
      { name: 'server', scope: 'server', sha256: hashKey('fake-server-key') },
      { name: 'launcher', scope: 'server', sha256: hashKey('fake-launcher-key') },
      { name: 'rescue', scope: 'rescue', sha256: hashKey('fake-rescue-key') },
    ]), { mode: 0o600 });
    await writeFile(config, JSON.stringify({ development: true, statusOnly: true, stateDir: '/home/me/state', adopt: { launchScript: '/opt/example/launch.sh' } }));
    await writeFile(site, JSON.stringify({ version: 1, configWrites: true, targets: {} }));
    expect(await loadKeys(keys)).toEqual(await currentKeys(keys));
    expect((await loadKeys(keys)).find(key => key.name === 'launcher')).toMatchObject({ scope: 'server' });
    expect(await loadConfig(config)).toEqual(await currentConfig(config));
    expect(await loadConfig(config)).toMatchObject({ statusOnly: true });
    expect(await readFile(config, 'utf8')).not.toContain('configWrites');
    expect(await readFile(site, 'utf8')).toContain('configWrites');
    await writeFile(config, '{"configWrites":true}');
    await expect(loadConfig(config)).rejects.toThrow();
    await writeFile(keys, JSON.stringify([{ name: 'launcher', scope: 'launcher', sha256: hashKey('fake-launcher-key') }]));
    await expect(loadKeys(keys)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
