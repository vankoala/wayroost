import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore, readCredential } from '../src/config.js';
import { startGateway } from '../src/gateway.js';
import { directoryMetadata, fileIdentity, rootGateway } from './filesystem-fixture.js';

vi.mock('node:fs/promises', { spy: true });

import { demoMap } from './map-fixture.js';
const config = demoMap();

describe('gateway filesystem trust', () => {
  let directory: string;
  let owners: Map<string, number>;
  let store: ConfigStore | undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;

  beforeEach(async () => {
    const root = join(process.cwd(), 'gateway/.test-tmp');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(join(root, 'fs-demo-'));
    owners = await directoryMetadata();
  });

  afterEach(async () => {
    await gateway?.close();
    await store?.close();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function setup() {
    const credentials = join(directory, 'credentials');
    const configDirectory = join(directory, 'config');
    const adminParent = join(directory, 'admin-parent');
    const admin = join(adminParent, 'admin');
    await fs.mkdir(credentials, { mode: 0o700 });
    await fs.mkdir(configDirectory, { mode: 0o700 });
    await fs.mkdir(adminParent, { mode: 0o700 });
    await fs.mkdir(admin, { mode: 0o700 });
    const configFile = join(configDirectory, 'roles.json');
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    return { credentials, configDirectory, adminSocket: join(admin, 'admin.sock'), configFile, ports: { main: 8898 } };
  }

  async function attempt(options: Parameters<typeof startGateway>[0]) {
    gateway = await startGateway(options);
  }

  it.each(['credentials', 'config', 'admin'] as const)('rejects a writable ancestor of the %s directory', async kind => {
    const paths = await setup();
    const parent = join(directory, 'untrusted');
    const child = join(parent, 'private');
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.mkdir(child, { mode: 0o700 });
    await fs.chmod(parent, 0o777);
    if (kind === 'credentials') {
      const key = join(child, 'demo-key');
      await fs.writeFile(key, 'obviously-fake-demo-key', { mode: 0o600 });
      await expect(readCredential(key, child)).rejects.toThrow();
      await expect(attempt({ ...paths, credentialsDirectory: child })).rejects.toThrow('Credentials directory');
    } else if (kind === 'config') {
      const file = join(child, 'roles.json');
      await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
      await expect(ConfigStore.load(file).then(value => { store = value; })).rejects.toThrow();
    } else {
      await expect(attempt({ ...paths, adminSocket: join(child, 'admin.sock') })).rejects.toThrow('Admin socket directory');
    }
  });

  it.each([
    ['directory', 'unprivileged'], ['directory', 'root'], ['ancestor', 'unprivileged'], ['ancestor', 'root'],
  ] as const)('rejects an admin %s owned by another account for a %s gateway', async (kind, caller) => {
    const paths = await setup();
    const target = kind === 'directory' ? join(directory, 'admin-parent/admin') : join(directory, 'admin-parent');
    if (caller === 'root') {
      // Model a root-owned deployment without chown or starting a privileged process.
      await rootGateway(owners, [paths.configFile, dirname(paths.adminSocket)]);
    }
    owners.set(fileIdentity(await fs.lstat(target)), 424242);
    await expect(attempt(paths)).rejects.toThrow('Admin socket directory');
  });

  it.each(['link', 'directory'] as const)('rejects a config directory replaced by a %s on reload and repoint', async replacement => {
    const paths = await setup();
    store = await ConfigStore.load(paths.configFile);
    const original = await fs.readFile(paths.configFile, 'utf8');
    const saved = join(directory, 'saved-config');
    const foreign = join(directory, 'foreign-config');
    await fs.mkdir(foreign, { mode: 0o700 });
    await fs.writeFile(join(foreign, 'roles.json'), 'demo foreign file', { mode: 0o600 });
    await fs.rename(paths.configDirectory, saved);
    if (replacement === 'link') await fs.symlink(foreign, paths.configDirectory);
    else {
      await fs.mkdir(paths.configDirectory, { mode: 0o700 });
      await fs.writeFile(paths.configFile, JSON.stringify(config), { mode: 0o600 });
    }
    await expect(store.reload()).rejects.toThrow();
    await expect(store.repoint('main', 'demo-b')).rejects.toThrow();
    expect(store.snapshot()).toEqual(config);
    expect(await fs.readFile(join(saved, 'roles.json'), 'utf8')).toBe(original);
    expect(await fs.readFile(join(foreign, 'roles.json'), 'utf8')).toBe('demo foreign file');
  });

  it('anchors a config write even if the directory is swapped between validation and creation', async () => {
    const paths = await setup();
    store = await ConfigStore.load(paths.configFile);
    const saved = join(directory, 'saved-config');
    const foreign = join(directory, 'foreign-config');
    await fs.mkdir(foreign, { mode: 0o700 });
    const foreignFile = join(foreign, 'roles.json');
    await fs.writeFile(foreignFile, 'demo foreign file', { mode: 0o600 });
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp')) {
        await fs.rename(paths.configDirectory, saved);
        await fs.symlink(foreign, paths.configDirectory);
      }
      return open(...args);
    });
    await expect(store.repoint('main', 'demo-b')).rejects.toThrow();
    expect(store.snapshot()).toEqual(config);
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('demo foreign file');
    expect(await fs.readdir(foreign)).toEqual(['roles.json']);
    expect(await fs.readdir(saved)).toEqual(['roles.json']);
  });

  it('anchors a credential read even if its directory is swapped after validation', async () => {
    const paths = await setup();
    const key = join(paths.credentials, 'demo-key');
    await fs.writeFile(key, 'obviously-fake-intended-key', { mode: 0o600 });
    const foreign = join(directory, 'foreign-credentials');
    await fs.mkdir(foreign, { mode: 0o700 });
    await fs.writeFile(join(foreign, 'demo-key'), 'obviously-fake-foreign-key', { mode: 0o600 });
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/demo-key')) {
        await fs.rename(paths.credentials, join(directory, 'saved-credentials'));
        await fs.symlink(foreign, paths.credentials);
      }
      return open(...args);
    });
    await expect(readCredential(key, paths.credentials)).rejects.toThrow();
  });
});
