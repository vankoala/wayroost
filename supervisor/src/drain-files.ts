import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { drainExecutorStateSchema, drainMarkerSchema } from '../../shared/supervisor-config.js';
import type { SettingsTargets } from '../../shared/settings-targets.js';
import { checkConfigDirectory, ConfigError } from './config-paths.js';
import { configCommand, type ConfigCommand } from './config-command.js';
import { currentEpoch, delegationsClear, gatewayReading, jsonCount, ownerJson, ownerText, processesClear, profileCronFiles, cronStoreClear, record } from './drain-readers.js';
import type { DrainIO, DrainState } from './drain-runtime.js';

export const DRAIN_UNIT = 'wayroost-drain-hermes-gateway.service';
export type HermesTarget = NonNullable<SettingsTargets['hermes']>;

export async function prepareDrainStorage(target: HermesTarget): Promise<void> {
  const uid = target.runAs.uid;
  if (process.getuid!() !== uid || target.drainMarker.runAs.uid !== uid) throw new ConfigError('unsafe_directory');
  for (const directory of [target.drainStateDir, dirname(target.drainMarker.path)]) {
    await checkConfigDirectory(directory, uid, true);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await checkConfigDirectory(directory, uid, true);
    const stat = await lstat(directory);
    if (directory === target.drainStateDir && (stat.uid !== uid || stat.mode & 0o077)) throw new ConfigError('unsafe_directory');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

export async function publishPrivate(path: string, value: unknown, exclusive = false, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, '.wayroost-' + randomUUID());
  try {
    const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    try {
      await output.chmod(mode);
      await output.writeFile(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
      await output.sync();
    } finally { await output.close(); }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  await syncDirectory(directory);
}

export function fileDrainIO(target: HermesTarget, command: ConfigCommand = configCommand(), request: typeof fetch = fetch, epoch: () => Promise<string> = currentEpoch): DrainIO {
  const uid = target.runAs.uid;
  if (process.getuid!() !== uid || target.drainMarker.runAs.uid !== uid) throw new Error();
  const statePath = join(target.drainStateDir, 'hermes-gateway.json');
  let phoneUnavailable = false;
  const systemctl = async (argv: string[], timeout = 150_000) => command(['systemctl', '--user', ...argv], { XDG_RUNTIME_DIR: '/run/user/' + uid }, timeout);
  const absent = async (path: string) => {
    await checkConfigDirectory(path, uid);
    try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  };
  const finishCapture = async (staging: string) => {
    for (const entry of await readdir(staging)) {
      const path = join(staging, entry);
      const stat = await lstat(path);
      if (!/^\.wayroost-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry)
        || !stat.isFile() || stat.uid !== uid || stat.mode & 0o077) throw new Error();
      await unlink(path);
    }
    await rmdir(staging);
    await syncDirectory(dirname(staging));
  };
  const recoverCapture = async (staging: string) => {
    await checkConfigDirectory(staging, uid, true);
    const stat = await lstat(staging);
    if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077) throw new Error();
    const journalPath = join(staging, 'recovery.json');
    const captured = join(staging, 'marker');
    if (await absent(journalPath)) {
      // An interruption before the durable intent cannot have captured a marker.
      await finishCapture(staging);
      return;
    }
    const journal = await ownerJson(journalPath, uid);
    if (!record(journal) || Object.keys(journal).length !== 1 || !('requested_at' in journal)
      || journal.requested_at !== null && !drainMarkerSchema.shape.requested_at.safeParse(journal.requested_at).success) throw new Error();
    if (!await absent(captured)) {
      let owned = false;
      try {
        const value = await ownerJson(captured, uid);
        owned = record(value) && value.principal === 'wayroost' && value.requested_at === journal.requested_at;
      } catch {}
      if (!owned) {
        try { await link(captured, target.drainMarker.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const source = await lstat(captured, { bigint: true });
          const restored = await lstat(target.drainMarker.path, { bigint: true });
          if (source.dev !== restored.dev || source.ino !== restored.ino) throw error;
        }
        // Keep the recovery copy until the public link is durable.
        await syncDirectory(dirname(target.drainMarker.path));
      }
      await unlink(captured);
      await syncDirectory(staging);
    }
    await unlink(journalPath);
    await finishCapture(staging);
  };
  return {
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async active(which) {
      const result = await command(which === 'gateway' ? ['systemctl', '--user', 'is-active', target.gatewayUnit] : ['systemctl', 'is-active', DRAIN_UNIT],
        which === 'gateway' ? { XDG_RUNTIME_DIR: '/run/user/' + uid } : {}, 5000);
      const state = result.stdout.trim();
      if (result.code === 0 && ['active', 'reloading'].includes(state)) return true;
      if (which === 'executor' && result.code === 3 && ['activating', 'deactivating'].includes(state)) return true;
      if ([3, 4].includes(result.code) && ['inactive', 'failed', 'unknown', 'activating', 'deactivating', ''].includes(state)) return false;
      throw new Error();
    },
    async gateway() { try { return gatewayReading(await ownerText(target.stateFile, uid)); } catch { return; } },
    async phone(timeoutMs) {
      if (!target.phoneHealth) return true;
      phoneUnavailable = true;
      const url = new URL(target.phoneHealth);
      if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/health' || url.protocol !== 'http:') return false;
      try {
        const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
        // The counters remain useful when a dependency makes /health answer 503.
        const reader = response.body?.getReader();
        if (!reader) return false;
        let source = '';
        let bytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 64 * 1024) return false;
            source += decoder.decode(chunk.value, { stream: true });
          }
          source += decoder.decode();
          const calls = jsonCount(source, 'active_calls');
          phoneUnavailable = calls === undefined;
          return calls === 0;
        } finally { await reader.cancel().catch(() => {}); }
      } catch { return false; }
    },
    phoneReleaseReason: () => phoneUnavailable ? 'phone-unavailable' : 'call-started',
    async cron() {
      try {
        const paths = [target.cronJobs, ...await profileCronFiles(target.profilesDir, uid)];
        for (const path of paths) if (!cronStoreClear(await ownerJson(path, uid), Date.now())) return false;
        return true;
      } catch { return false; }
    },
    async background() {
      try {
        const clear = processesClear(await ownerJson(target.processesFile, uid), pid => {
          try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        });
        return clear && await delegationsClear(target.stateDatabase, uid);
      } catch { return false; }
    },
    async marker() {
      if (await absent(target.drainMarker.path)) return null;
      try { const marker = await ownerJson(target.drainMarker.path, uid); return record(marker) ? marker : {}; }
      catch { return {}; }
    },
    async publishMarker(at) {
      await checkConfigDirectory(target.drainMarker.path, uid);
      const marker = drainMarkerSchema.parse({ action: 'drain', requested_at: at, principal: 'wayroost', epoch: await epoch(), suppress_notification: true });
      try { await publishPrivate(target.drainMarker.path, marker, true); return true; }
      catch { return false; }
    },
    async removeMarker(at) {
      if (at !== null && !drainMarkerSchema.shape.requested_at.safeParse(at).success) throw new Error();
      await this.recoverMarkers!();
      const marker = await this.marker();
      if (marker?.principal === 'wayroost' && marker.requested_at === at) {
        const parent = dirname(target.drainMarker.path);
        const staging = join(parent, '.wayroost-drain-' + randomUUID());
        await mkdir(staging, { mode: 0o700 });
        const captured = join(staging, 'marker');
        // Persist the intent and directory entry before moving a possibly replaced marker.
        await publishPrivate(join(staging, 'recovery.json'), { requested_at: at }, true);
        await syncDirectory(parent);
        try { await rename(target.drainMarker.path, captured); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await syncDirectory(staging);
        await syncDirectory(parent);
        await recoverCapture(staging);
      }
    },
    async recoverMarkers() {
      const parent = dirname(target.drainMarker.path);
      await checkConfigDirectory(parent, uid, true);
      let entries: string[];
      try { entries = await readdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (/^\.wayroost-drain-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry)) await recoverCapture(join(parent, entry));
      }
    },
    async save(state) {
      await checkConfigDirectory(target.drainStateDir, uid, true);
      await mkdir(target.drainStateDir, { recursive: true, mode: 0o700 });
      const stat = await lstat(target.drainStateDir);
      if (stat.uid !== uid || stat.mode & 0o077) throw new Error();
      if (!await absent(statePath)) await ownerText(statePath, uid);
      await publishPrivate(statePath, drainExecutorStateSchema.parse(state));
    },
    async load() {
      if (await absent(statePath)) return null;
      return drainExecutorStateSchema.parse(JSON.parse(await ownerText(statePath, uid)));
    },
    async deleteState() { await unlink(statePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); },
    async stop(timeoutMs = 150_000) { if ((await systemctl(['stop', target.gatewayUnit], timeoutMs)).code !== 0) throw new Error(); },
    async start(noBlock = false) { if ((await systemctl([...(noBlock ? ['--no-block'] : []), 'start', target.gatewayUnit])).code !== 0) throw new Error(); },
  };
}
