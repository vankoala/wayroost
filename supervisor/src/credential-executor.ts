import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { credentialWriteRequestSchema, credentialWriteResultSchema, type CredentialWriteRequest } from '../../shared/supervisor-config.js';
import { credentialSecretSchema } from '../../shared/settings.js';
import { roleMapProviders, roleMapSchema } from '../../shared/gateway.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { readBounded } from '../../server/src/hub/safe-read.js';
import { checkConfigDirectory, configFileMissing, ConfigError, readConfigFile } from './config-paths.js';
import { configErrorCode } from './config-executor.js';
import { configCommand, type ConfigCommand } from './config-command.js';
import { publishPrivate } from './drain-files.js';
import { record } from './drain-readers.js';
import { withConfigFileLock } from './config-locks.js';

export type CredentialResult = z.infer<typeof credentialWriteResultSchema>;
export function credentialDirectories(site: SettingsTargets): string[] {
  const target = site.targets['gateway-credentials'];
  if (!target) throw new ConfigError('not_configured');
  return [...new Set([target.directory, dirname(target.dropIn), target.backupDir, dirname(target.lockFile)])];
}
export async function prepareCredentialStorage(site: SettingsTargets, uid = process.getuid!()): Promise<void> {
  if (!site.configWrites) throw new ConfigError('config_writes_off');
  if (uid !== 0) throw new ConfigError('not_permitted');
  const directories = credentialDirectories(site);
  for (const directory of directories) await checkConfigDirectory(directory, 0, true);
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkConfigDirectory(directory, 0, true);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022
      || directory === site.targets['gateway-credentials']!.directory && stat.mode & 0o077) throw new ConfigError('unsafe_directory');
  }
}
export async function credentialMap(site: SettingsTargets) {
  const target = site.targets['gateway-role-map'];
  if (!target) throw new ConfigError('not_configured');
  const result = await readBounded(target.path, { root: '/', maxBytes: 1024 * 1024 });
  if ('refused' in result) throw new ConfigError('unsafe_target');
  try { return roleMapSchema.parse(JSON.parse(result.text)); }
  catch { throw new ConfigError('parse_failed'); }
}

export async function credentialProviders(site: SettingsTargets): Promise<string[]> {
  return roleMapProviders(await credentialMap(site));
}

/** Stored keys are bounded, root-owned regular files; probes never create storage. */
export async function storedCredential(site: SettingsTargets, provider: string): Promise<string | undefined> {
  const target = site.targets['gateway-credentials'];
  if (!target) throw new ConfigError('not_configured');
  try {
    const file = await readConfigFile(join(target.directory, provider), 0, 0o600, 'owner', 16 * 1024);
    const secret = credentialSecretSchema.safeParse(file.source);
    return secret.success ? secret.data : undefined;
  } catch { return undefined; }
}

export async function readImportKey(site: SettingsTargets, provider: string, uid = process.getuid!()): Promise<string> {
  const target = site.targets['pi-models'];
  const source = site.keySources.find(source => source.provider === provider);
  if (!target || !source) throw new ConfigError('not_configured');
  if (uid === 0 || uid !== target.runAs.uid) throw new ConfigError('not_permitted');
  await checkConfigDirectory(target.path, uid);
  const file = await readBounded(target.path, { root: '/', maxBytes: 4 * 1024 * 1024, ownerUid: uid, fileMode: target.mode ?? 0o600 });
  if ('refused' in file) throw new ConfigError('unsafe_target');
  let value: unknown;
  try { value = JSON.parse(file.text); } catch { throw new ConfigError('parse_failed'); }
  if (!record(value) || !record(value.providers) || !Object.hasOwn(value.providers, source.piProvider)) throw new ConfigError('parse_failed');
  const entry = value.providers[source.piProvider];
  if (!record(entry)) throw new ConfigError('parse_failed');
  const secret = credentialSecretSchema.safeParse(entry.apiKey);
  if (!secret.success) throw new ConfigError('parse_failed');
  return secret.data;
}

export async function executeCredential(site: SettingsTargets, input: unknown, command: ConfigCommand = configCommand(), uid = process.getuid!()): Promise<CredentialResult> {
  const parsed = credentialWriteRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
  if (!site.configWrites) return { ok: false, code: 'config_writes_off' };
  if (uid !== 0) return { ok: false, code: 'not_permitted' };
  const target = site.targets['gateway-credentials'];
  if (!target) return { ok: false, code: 'not_configured' };
  const request = parsed.data;
  let wrote = false;
  try {
    if (!(await credentialProviders(site)).includes(request.provider)) throw new ConfigError('invalid_parameters');
    await prepareCredentialStorage(site, uid);
    return await withConfigFileLock(target.lockFile, 0, async () => {
      const path = join(target.directory, request.provider);
      if (!await configFileMissing(path, 0)) await readConfigFile(path, 0, 0o600);
      const exists = !await configFileMissing(target.dropIn, 0);
      const original = exists ? (await readConfigFile(target.dropIn, 0, 0o644)).source : '[Service]\n';
      const source = credentialDropIn(original, request, path);
      wrote = true;
      if (request.action === 'set') await publishPrivate(path, request.secret);
      else if (!await configFileMissing(path, 0)) await unlink(path);
      if (exists && source !== original) await publishPrivate(join(target.backupDir, 'credentials-' + request.requestId + '.conf'), original, true, 0o644);
      await publishPrivate(target.dropIn, source, false, 0o644);
      if ((await readConfigFile(target.dropIn, 0, 0o644)).source !== source) throw new ConfigError('verify_mismatch');
      if ((await command(['systemctl', 'daemon-reload'], {}, 15_000)).code !== 0) throw new ConfigError('failed');
      if (request.action === 'set' && (await readConfigFile(path, 0, 0o600)).source !== request.secret) throw new ConfigError('verify_mismatch');
      return { ok: true, provider: request.provider, timing: 'restart-when-idle:gateway' };
    });
  } catch (error) { return { ok: false, code: wrote ? 'outcome_unknown' : configErrorCode(error) }; }
}

export function credentialDropIn(original: string, request: Pick<CredentialWriteRequest, 'action' | 'provider'>, path: string): string {
  const lines = original.split('\n');
  let section = '';
  const output: string[] = [];
  let inserted = false;
  const insert = () => {
    // LoadCredential keeps its source literal apart from systemd specifiers.
    if (request.action === 'set' && !inserted) output.push('LoadCredential=' + request.provider + ':' + path.replace(/%/g, '%%'));
    inserted = true;
  };
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { if (section === 'Service') insert(); section = heading[1]!; }
    if (section === 'Service' && new RegExp('^\\s*LoadCredential\\s*=\\s*' + request.provider + '(?::|$)').test(line)) continue;
    output.push(line);
  }
  if (section === 'Service') insert();
  if (!inserted) { output.push('[Service]'); insert(); }
  return output.join('\n').replace(/\n*$/, '\n');
}
