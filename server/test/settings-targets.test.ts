import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_OPERATIONS, operationTarget, type OperationSpec } from '../../shared/settings-ops.js';
import {
  OWNER_FILE_TARGETS, READ_ONLY_TARGETS, ROOT_TARGETS, TARGET_IDS, absolutePathSchema, settingsTargetsSchema, socketPathSchema, storagePathsApart,
} from '../../shared/settings-targets.js';

const me = { user: 'me', uid: 1234 };
const home = '/home/me';
const store = (id: string) => ({ backupDir: `${home}/.wayroost-config/backups/${id}`, auditDir: `${home}/.wayroost-config/audit/${id}` });

/** A complete site file with invented paths, built fresh for each test. */
function siteFile(): Record<string, any> {
  return {
    version: 1,
    configWrites: true,
    targets: {
      'hermes-config': { path: `${home}/.demo-hermes/config.yaml`, format: 'yaml', runAs: me, mode: 0o600, ...store('hermes-config'),
        lock: { kind: 'file', path: `${home}/.wayroost-config/locks/hermes-config.lock` } },
      'pi-settings': { path: `${home}/.demo-pi/settings.json`, format: 'json', runAs: me, ...store('pi-settings'), lock: { kind: 'pi', path: `${home}/.demo-pi/settings.json.lock` } },
      'pi-models': { path: `${home}/.demo-pi/models.json`, format: 'json', runAs: me, mode: 0o600, ...store('pi-models'),
        lock: { kind: 'file', path: `${home}/.wayroost-config/locks/pi-models.lock` } },
      'pi-mcp': { path: `${home}/.demo-pi/mcp.json`, format: 'json', runAs: me, mode: 0o600, ...store('pi-mcp'),
        lock: { kind: 'file', path: `${home}/.wayroost-config/locks/pi-mcp.lock` } },
      'paseo-config': { path: `${home}/.demo-paseo/config.json`, format: 'json', runAs: me, ...store('paseo-config'), lock: { kind: 'paseo', path: `${home}/.demo-paseo/config.json.wayroost.lock` },
        loader: '/usr/lib/node_modules/demo-paseo/dist/exports.js' },
      'wayroost-settings': { path: `${home}/.demo-wayroost/settings.json`, format: 'json', runAs: me, ...store('wayroost-settings'),
        lock: { kind: 'file', path: `${home}/.wayroost-config/locks/wayroost-settings.lock` } },
      'gateway-role-map': { path: '/var/lib/private/wayroost-gateway/role-map.json', defaultMap: '/usr/lib/wayroost-gateway/role-map.default.json',
        adminSocket: '/run/wayroost-gateway/admin.sock', service: 'wayroost-gateway.service', socket: 'wayroost-gateway.socket' },
      'gateway-credentials': { directory: '/etc/wayroost/gateway-credentials', dropIn: '/etc/systemd/system/wayroost-gateway.service.d/credentials.conf',
        service: 'wayroost-gateway.service', lockFile: '/var/lib/wayroost-supervisor/gateway-credentials.lock',
        backupDir: '/var/lib/wayroost-supervisor/config-backups/gateway-credentials' },
      'gateway-state': { directory: '/var/lib/wayroost-supervisor/gateway', backupDir: '/var/lib/wayroost-supervisor/config-backups/gateway-state' },
      'hermes-managed': { path: '/etc/demo-hermes/config.yaml', format: 'yaml', runAs: me },
      'windows-hermes': { path: '/mnt/c/Users/me/AppData/Local/demo-hermes/config.yaml', format: 'yaml', runAs: me, drvfs: true },
      'claude-settings': { path: `${home}/.demo-claude/settings.json`, format: 'json', runAs: me },
      'codex-config': { path: `${home}/.demo-codex/config.toml`, format: 'toml', runAs: me },
      'opencode-config': { path: `${home}/.demo-opencode/opencode.json`, format: 'json', runAs: me },
    },
    roleAddresses: { main: 'http://127.0.0.1:19031/v1', coder: 'http://127.0.0.1:19032/v1', fast: 'http://127.0.0.1:19033/v1' },
    coderMcp: { original: `${home}/demo/scripts/helper-mcp.py`, gatewayCopy: '/opt/example/helper-mcp.py' },
    keySources: [{ provider: 'demo-local', piProvider: 'local-demo' }],
    hermes: {
      runAs: me, gatewayUnit: 'demo-gateway.service', dashboardUnit: { name: 'demo-dashboard.service', scope: 'system' },
      stateFile: `${home}/.demo-hermes/gateway_state.json`, cronJobs: `${home}/.demo-hermes/cron/jobs.json`,
      profilesDir: `${home}/.demo-hermes/profiles`, processesFile: `${home}/.demo-hermes/processes.json`,
      stateDatabase: `${home}/.demo-hermes/state.db`, drainStateDir: `${home}/.wayroost-config/drain`,
      drainMarker: { path: `${home}/.demo-hermes/drain.json`, runAs: me }, phoneHealth: 'http://127.0.0.1:19051/health',
    },
  };
}

const parses = (file: unknown) => settingsTargetsSchema.safeParse(file).success;
let folder: string | undefined;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); folder = undefined; });

describe('settings-targets.json', () => {
  it('parses a complete site file written as JSON', () => {
    folder = mkdtempSync(join(tmpdir(), 'wayroost-targets-'));
    const path = join(folder, 'settings-targets.json');
    writeFileSync(path, JSON.stringify(siteFile(), null, 2) + '\n', { mode: 0o600 });
    const parsed = settingsTargetsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(parsed.configWrites).toBe(true);
    expect(parsed.targets['windows-hermes']?.drvfs).toBe(true);
    expect(parsed.targets['claude-settings']?.drvfs).toBe(false);
  });

  it('starts with config writes off and every target optional', () => {
    const parsed = settingsTargetsSchema.parse({ version: 1, targets: {} });
    expect(parsed.configWrites).toBe(false);
    expect(parsed.keySources).toEqual([]);
  });

  it('has an entry for every target the catalogue writes', () => {
    const shape = Object.keys(siteFile().targets).sort();
    expect(shape).toEqual([...TARGET_IDS].sort());
    expect([...OWNER_FILE_TARGETS, ...ROOT_TARGETS, ...READ_ONLY_TARGETS].sort()).toEqual([...TARGET_IDS].sort());
    for (const spec of Object.values(SETTINGS_OPERATIONS) as OperationSpec[]) {
      if (typeof spec.target === 'string') expect(TARGET_IDS).toContain(spec.target);
      else for (const target of OWNER_FILE_TARGETS) expect(TARGET_IDS).toContain(operationTarget(spec, { target }));
    }
  });

  it('refuses unknown fields and unknown targets', () => {
    expect(parses({ ...siteFile(), statusOnly: false })).toBe(false);
    const file = siteFile();
    file.targets['demo-target'] = { path: '/home/me/x', format: 'json', runAs: me };
    expect(parses(file)).toBe(false);
    const extra = siteFile();
    extra.targets['pi-mcp'].command = 'id';
    expect(parses(extra)).toBe(false);
  });

  it('never runs a consumer file as root', () => {
    for (const target of ['hermes-config', 'windows-hermes'] as const) {
      const file = siteFile();
      file.targets[target].runAs = { user: 'root', uid: 0 };
      expect(parses(file)).toBe(false);
      file.targets[target].runAs = { user: 'me', uid: 0 };
      expect(parses(file)).toBe(false);
    }
    const marker = siteFile();
    marker.hermes.drainMarker.runAs = { user: 'root', uid: 0 };
    expect(parses(marker)).toBe(false);
  });

  it('keeps backups and the audit apart, and the target out of both', () => {
    const same = siteFile();
    same.targets['hermes-config'].auditDir = same.targets['hermes-config'].backupDir;
    expect(parses(same)).toBe(false);
    const nested = siteFile();
    nested.targets['pi-models'].auditDir = `${nested.targets['pi-models'].backupDir}/audit`;
    expect(parses(nested)).toBe(false);
    const target = siteFile();
    target.targets['pi-mcp'].path = `${target.targets['pi-mcp'].backupDir}/mcp.json`;
    expect(parses(target)).toBe(false);
    const lock = siteFile();
    lock.targets['hermes-config'].lock.path = lock.targets['hermes-config'].path;
    expect(parses(lock)).toBe(false);
  });

  it('uses each target\'s own lock kind', () => {
    const pi = siteFile();
    pi.targets['pi-settings'].lock = { kind: 'file', path: '/home/me/.wayroost-config/locks/pi-settings.lock' };
    expect(parses(pi)).toBe(false);
    const paseo = siteFile();
    paseo.targets['paseo-config'].lock = { kind: 'pi' };
    expect(parses(paseo)).toBe(false);
    const format = siteFile();
    format.targets['hermes-config'].format = 'json';
    expect(parses(format)).toBe(false);
  });

  it('keeps all owner target files, locks and storage roots pairwise apart', () => {
    for (const id of OWNER_FILE_TARGETS) {
      for (const field of ['backupDir', 'auditDir']) {
        const file = siteFile();
        file.targets[id].lock.path = file.targets[id][field];
        expect(parses(file), `${id}:${field}`).toBe(false);
        const nested = siteFile();
        nested.targets[id][field] = `${nested.targets[id].path}/storage`;
        expect(parses(nested), `${id}:${field}`).toBe(false);
      }
    }
  });

  it('keeps the credential drop-in apart from backup storage in both directions', () => {
    const dropIn = siteFile().targets['gateway-credentials'].dropIn;
    for (const backupDir of [dropIn, `${dropIn}/backups`, dropIn.slice(0, dropIn.lastIndexOf('/'))]) {
      const file = siteFile();
      file.targets['gateway-credentials'].backupDir = backupDir;
      expect(parses(file), backupDir).toBe(false);
    }
  });

  it('rejects aliases and nesting across targets too', () => {
    const file = siteFile();
    file.targets['pi-models'].backupDir = file.targets['hermes-config'].backupDir;
    expect(parses(file)).toBe(false);
    file.targets['pi-models'].backupDir = `${file.targets['hermes-config'].path}/backups`;
    expect(parses(file)).toBe(false);
  });

  it.each(['stateFile', 'cronJobs', 'profilesDir', 'processesFile', 'stateDatabase', 'drainStateDir', 'drainMarker'])
    ('keeps Hermes %s apart from target files, locks and storage roots', field => {
      const targets = siteFile().targets;
      const paths = [targets['hermes-config'].path, targets['hermes-config'].lock.path,
        targets['pi-models'].backupDir, targets['pi-mcp'].auditDir, targets['gateway-credentials'].directory,
        targets['gateway-credentials'].dropIn, targets['gateway-credentials'].lockFile,
        targets['gateway-state'].directory, targets['gateway-role-map'].adminSocket];
      for (const path of paths) {
        for (const overlapping of [path, `${path}/nested`, path.slice(0, path.lastIndexOf('/'))]) {
          const file = siteFile();
          if (field === 'drainMarker') file.hermes.drainMarker.path = overlapping;
          else file.hermes[field] = overlapping;
          expect(parses(file), `${field}:${overlapping}`).toBe(false);
        }
        const adjacent = siteFile();
        if (field === 'drainMarker') adjacent.hermes.drainMarker.path = `${path}-drain`;
        else adjacent.hermes[field] = `${path}-drain`;
        expect(parses(adjacent), `${field}:${path}-drain`).toBe(true);
      }
    });

  it('keeps drain writes apart from each other and all drain inputs without configured targets', () => {
    const hermes = siteFile().hermes;
    const paths = [hermes.stateFile, hermes.cronJobs, hermes.profilesDir, hermes.processesFile, hermes.stateDatabase];
    expect(parses({ version: 1, targets: {}, hermes })).toBe(true);
    for (const field of ['drainStateDir', 'drainMarker']) {
      const otherWrite = field === 'drainMarker' ? hermes.drainStateDir : hermes.drainMarker.path;
      for (const path of [...paths, otherWrite]) {
        for (const overlapping of [path, `${path}/nested`, path.slice(0, path.lastIndexOf('/'))]) {
          const file = { version: 1, targets: {}, hermes: siteFile().hermes };
          if (field === 'drainMarker') file.hermes.drainMarker.path = overlapping;
          else file.hermes[field] = overlapping;
          expect(parses(file), `${field}:${overlapping}`).toBe(false);
        }
      }
    }
  });

  it('checks normalisation and every pair symmetrically with path-segment boundaries', () => {
    const paths = ['/home/me/settings.json', '/home/me/settings.lock', '/home/me/backups', '/home/me/audit'];
    expect(storagePathsApart(paths)).toBe(true);
    expect(storagePathsApart(['/home/me/config', '/home/me/config-copy'])).toBe(true);
    for (let a = 0; a < paths.length; a++) {
      for (let b = 0; b < paths.length; b++) {
        if (a === b) continue;
        for (const overlapping of [paths[a]!, `${paths[a]!}/nested`]) {
          const invalid = [...paths];
          invalid[b] = overlapping;
          expect(storagePathsApart(invalid), `${a}:${b}:${overlapping}`).toBe(false);
        }
      }
    }
    for (const path of ['relative', '/home/me/../backups', '/home//me', '/home/me/', '/']) {
      expect(storagePathsApart([paths[0]!, path]), path).toBe(false);
    }
  });

  it('requires the same explicit pi and Paseo lock path for every writer', () => {
    for (const id of ['pi-settings', 'paseo-config'] as const) {
      const missing = siteFile();
      delete missing.targets[id].lock.path;
      expect(parses(missing), id).toBe(false);
      for (const path of [siteFile().targets[id].path, `${store(id).backupDir}/lock`, `${store(id).auditDir}/lock`, 'relative.lock']) {
        const invalid = siteFile();
        invalid.targets[id].lock.path = path;
        expect(parses(invalid), `${id}:${path}`).toBe(false);
      }
      const parsed = settingsTargetsSchema.parse(siteFile());
      expect(parsed.targets[id]?.lock.path).toBe(siteFile().targets[id].lock.path);
    }
  });

  it('names every store used for background and profile cron drain checks', () => {
    for (const field of ['profilesDir', 'processesFile', 'stateDatabase', 'drainStateDir']) {
      const file = siteFile();
      delete file.hermes[field];
      expect(parses(file), field).toBe(false);
    }
  });

  it('accepts only canonical absolute paths', () => {
    for (const path of ['relative/path', '/home/me/../etc/passwd', '/home/me/./x', '/home//me', '/home/me/', `/home/me/x${String.fromCharCode(10)}y`, '']) {
      expect(absolutePathSchema.safeParse(path).success, JSON.stringify(path)).toBe(false);
    }
    expect(absolutePathSchema.safeParse('/').success).toBe(true);
    expect(socketPathSchema.safeParse(`/run/${'s'.repeat(103)}`).success).toBe(false);
    expect(socketPathSchema.safeParse('/run/wayroost-gateway/admin.sock').success).toBe(true);
  });

  it('puts the credentials drop-in in the gateway service\'s own drop-in folder, apart from the keys', () => {
    const elsewhere = siteFile();
    elsewhere.targets['gateway-credentials'].dropIn = '/etc/systemd/system/other.service.d/credentials.conf';
    expect(parses(elsewhere)).toBe(false);
    const inside = siteFile();
    inside.targets['gateway-credentials'].backupDir = '/etc/wayroost/gateway-credentials/backups';
    expect(parses(inside)).toBe(false);
  });

  it('keeps the credential lock separate from the drop-in and backup storage', () => {
    const target = siteFile().targets['gateway-credentials'];
    for (const lockFile of [target.dropIn, target.backupDir, `${target.backupDir}/credentials.lock`, `${target.backupDir}/nested/credentials.lock`]) {
      const file = siteFile();
      file.targets['gateway-credentials'].lockFile = lockFile;
      expect(parses(file), lockFile).toBe(false);
    }
    const adjacent = siteFile();
    adjacent.targets['gateway-credentials'].lockFile = `${target.backupDir}.lock`;
    expect(parses(adjacent)).toBe(true);
    expect(parses(siteFile())).toBe(true);
  });

  it('requires credential drop-ins to be direct .conf children of the exact service folder', () => {
    for (const service of ['demo.service', 'demo@worker.service']) {
      for (const name of ['credentials.conf', '10-credentials.conf', 'demo_credentials.conf', 'demo.extra.conf']) {
        const file = siteFile();
        file.targets['gateway-credentials'].service = service;
        file.targets['gateway-credentials'].dropIn = `/etc/systemd/system/${service}.d/${name}`;
        expect(parses(file)).toBe(true);
      }
      for (const name of ['subdir/credentials.conf', 'subdir/nested/credentials.conf', 'credentials', 'credentials.conf.bak',
        '.credentials.conf', '.conf', 'credentials .conf', 'credentials~.conf', '#credentials.conf', 'credentials@.conf']) {
        const file = siteFile();
        file.targets['gateway-credentials'].service = service;
        file.targets['gateway-credentials'].dropIn = `/etc/systemd/system/${service}.d/${name}`;
        expect(parses(file), name).toBe(false);
      }
    }
  });

  it.each([
    ['http://127.0.0.1/v1', 'https://127.0.0.1:80/v1'],
    ['https://localhost/v1', 'http://localhost:443/v1'],
    ['http://127.0.0.1:19031/v1', 'http://[::1]:19031/v1'],
    ['https://127.0.0.2:19031/v1', 'http://localhost:19031/other'],
  ])('compares effective role ports across schemes and hosts: %s and %s', (main, coder) => {
    const file = siteFile();
    file.roleAddresses = { main, coder, fast: 'http://127.0.0.1:19033/v1' };
    const parsed = settingsTargetsSchema.safeParse(file);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ['roleAddresses'], message: 'each role on its own port' }));
  });

  it('accepts different effective role ports, including scheme defaults', () => {
    const file = siteFile();
    file.roleAddresses = { main: 'http://localhost/v1', coder: 'https://[::1]/v1', fast: 'http://127.0.0.2:19033/v1' };
    expect(parses(file)).toBe(true);
  });

  it.each(['invalid', '', 'http://[::1', 'http://127.0.0.1:99999/v1', 'file:///home/me/settings.json', 'https://example.com/v1'])
    ('returns validation issues for malformed or non-loopback role addresses: %s', address => {
      for (const role of ['main', 'coder', 'fast']) {
        const file = siteFile();
        file.roleAddresses[role] = address;
        const parsed = settingsTargetsSchema.safeParse(file);
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ['roleAddresses', role] }));
      }
    });

  it('checks key sources and role addresses', () => {
    const twice = siteFile();
    twice.keySources.push({ provider: 'demo-local', piProvider: 'local-other' });
    expect(parses(twice)).toBe(false);
    const noCatalog = siteFile();
    delete noCatalog.targets['pi-models'];
    expect(parses(noCatalog)).toBe(false);
    const remote = siteFile();
    remote.roleAddresses.main = 'https://example.com/v1';
    expect(parses(remote)).toBe(false);
    const shared = siteFile();
    shared.roleAddresses.fast = shared.roleAddresses.coder;
    expect(parses(shared)).toBe(false);
    const sameScript = siteFile();
    sameScript.coderMcp.gatewayCopy = sameScript.coderMcp.original;
    expect(parses(sameScript)).toBe(false);
  });
});
