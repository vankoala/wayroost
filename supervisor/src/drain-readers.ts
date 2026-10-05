import { open, readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import { cronBlocksDrain, drainCountSchema } from '../../shared/supervisor-config.js';
import { readBounded } from '../../server/src/hub/safe-read.js';

export const isoTimestamp = z.iso.datetime({ offset: true });
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export async function ownerText(path: string, uid: number, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const result = await readBounded(path, { root: '/', ownerUid: uid, maxBytes });
  if ('refused' in result) throw new Error();
  return result.text;
}
export async function ownerJson(path: string, uid: number): Promise<unknown> { return JSON.parse(await ownerText(path, uid)); }

async function ownerDirectory<T>(path: string, uid: number, work: (file: FileHandle, unchanged: () => Promise<boolean>) => Promise<T>, missing?: () => T): Promise<T> {
  const handles: FileHandle[] = [];
  const chain: { path: string; file: FileHandle; stat: BigIntStats }[] = [];
  try {
    const components = ['/', ...path.split('/').filter(Boolean)];
    for (const [index, component] of components.entries()) {
      if (component === '.' || component === '..') throw new Error();
      const parent = handles.at(-1);
      let file: FileHandle;
      try {
        file = await open(parent ? `/proc/self/fd/${parent.fd}/${component}` : component,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (missing && index === components.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return missing();
        throw error;
      }
      handles.push(file);
      const stat = await file.stat({ bigint: true });
      if (!stat.isDirectory() || index > 0 && stat.uid !== 0n && stat.uid !== BigInt(uid)) throw new Error();
      chain.push({ path: index === 0 ? '/' : join(chain.at(-1)!.path, component), file, stat });
    }
    const owner = await handles.at(-1)!.stat();
    if (owner.uid !== 0 && owner.uid !== uid) throw new Error();
    return await work(handles.at(-1)!, async () => {
      // SQLite reopens a resolved name, so every ancestor must still name its pinned directory.
      for (const entry of chain) {
        const current = await lstat(entry.path, { bigint: true });
        const pinned = await entry.file.stat({ bigint: true });
        for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs'] as const) {
          if (current[field] !== entry.stat[field] || pinned[field] !== entry.stat[field]) return false;
        }
      }
      return true;
    });
  } finally { for (const file of handles.reverse()) await file.close(); }
}

/** Preserve the number token: JSON's 0.0 and 0e0 are not integer counts. */
export function jsonCount(source: string, field: string): number | undefined {
  const tokens = new WeakMap<object, string>();
  try {
    const value: unknown = JSON.parse(source, function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (key === field && context?.source) tokens.set(this, context.source);
      return value;
    });
    if (!record(value)) return;
    const parsed = drainCountSchema.safeParse(tokens.get(value));
    return parsed.success && Number.isSafeInteger(parsed.data) ? parsed.data : undefined;
  } catch { return; }
}

export interface GatewayReading { state: string; count?: number; updatedAt?: string; pid?: number; startTime?: number; chat: boolean; workKnown: boolean }
export function gatewayReading(source: string): GatewayReading | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (!record(value) || typeof value.gateway_state !== 'string' || !isoTimestamp.safeParse(value.updated_at).success) return;
    const count = jsonCount(source, 'active_agents');
    const work = value.active_work;
    const workKnown = work === null ? count === 0 : Array.isArray(work) && work.every(item => record(item) && typeof item.kind === 'string');
    return { state: value.gateway_state, count, updatedAt: value.updated_at as string,
      pid: Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? value.pid as number : undefined,
      startTime: Number.isSafeInteger(value.start_time) && Number(value.start_time) > 0 ? value.start_time as number : undefined,
      chat: Array.isArray(work) && workKnown && work.some(item => item.kind === 'chat'), workKnown };
  } catch { return; }
}

export function cronStoreClear(value: unknown, now: number): boolean {
  const jobs = record(value) ? value.jobs : value;
  if (!Array.isArray(jobs)) return false;
  return jobs.every(job => {
    if (!record(job)) return false;
    const schedule = record(job.schedule) ? job.schedule : job;
    const claims: unknown[] = [];
    for (const name of ['fire_claim', 'run_claim']) {
      const claim = job[name];
      if (claim == null) continue;
      if (!record(claim)) return false;
      claims.push(claim.at);
    }
    const kind = schedule.kind === 'once' ? 'once' : ['cron', 'interval', 'recurring'].includes(String(schedule.kind)) ? 'recurring' : undefined;
    if (typeof job.enabled !== 'boolean') return false;
    if (job.paused_at != null && !isoTimestamp.safeParse(job.paused_at).success) return false;
    return !cronBlocksDrain({ kind, runnable: job.enabled && job.paused !== true && job.paused_at == null && !['paused', 'completed', 'error'].includes(String(job.state)),
      ...(job.next_run_at != null ? { nextRunAt: job.next_run_at } : {}), claims }, now);
  });
}

export async function profileCronFiles(directory: string, uid: number): Promise<string[]> {
  return ownerDirectory(directory, uid, async handle => {
    const stat = await handle.stat();
    if (stat.uid !== uid || stat.mode & 0o022) throw new Error();
    const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error();
      if (entry.isDirectory()) files.push(join(directory, entry.name, 'cron/jobs.json'));
    }
    return files;
  }, () => []);
}

export function processesClear(value: unknown, alive: (pid: number) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(entry => record(entry) && entry.pid_scope === 'host' && Number.isSafeInteger(entry.pid) && Number(entry.pid) > 0 && !alive(entry.pid as number));
}

export async function delegationsClear(path: string, uid: number): Promise<boolean> {
  try {
    return await ownerDirectory(dirname(path), uid, async (parent, ancestorsUnchanged) => {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const files: { path: string; file?: FileHandle; stat?: BigIntStats }[] = [];
      try {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          const entry: typeof files[number] = { path: `/proc/self/fd/${parent.fd}/${name}${suffix}` };
          files.push(entry);
          try { entry.file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
          catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          entry.stat = await entry.file.stat({ bigint: true });
          const stat = entry.stat;
          if (!stat.isFile() || stat.uid !== BigInt(uid) || stat.nlink !== 1n || stat.mode & 0o022n || stat.size > 256n * 1024n * 1024n) return false;
        }
        // A WAL reader needs an existing shared index; never create missing sidecars.
        if (!!files[1]!.file !== !!files[2]!.file || files[3]!.file) return false;
        const unchanged = async () => {
          if (!await ancestorsUnchanged()) return false;
          for (const entry of files) {
            let current: BigIntStats;
            try { current = await lstat(entry.path, { bigint: true }); }
            catch (error) { if (!entry.stat && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
            if (!entry.stat || !entry.file) return false;
            const pinned = await entry.file.stat({ bigint: true });
            for (const field of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) {
              if (current[field] !== entry.stat[field] || pinned[field] !== entry.stat[field]) return false;
            }
          }
          return await ancestorsUnchanged();
        };
        const filename = await realpath(files[0]!.path);
        if (!await unchanged()) return false;
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(`/proc/self/fd/${files[0]!.file!.fd}`, { readOnly: true });
        try {
          // The resolved filename, its ancestors and sidecars must match the pinned files.
          const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
          if (main?.file !== filename || !await unchanged()) return false;
          const clear = db.prepare("SELECT 1 FROM async_delegations WHERE state = 'running' LIMIT 1").get() === undefined;
          return await unchanged() && clear;
        }
        finally { db.close(); }
      } finally { for (const entry of files.reverse()) await entry.file?.close(); }
    });
  } catch { return false; }
}

/** PID 1's comm can contain spaces and parentheses; field 22 follows its final ')'. */
export function instantiationEpoch(bootId: string, pid1Stat: string): string {
  const boot = bootId.trim();
  const fields = pid1Stat.slice(pid1Stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const start = fields[19];
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot) || !start || !/^[0-9]+$/.test(start)) throw new Error();
  return boot + ':' + start;
}
export async function currentEpoch(): Promise<string> {
  return instantiationEpoch(await readFile('/proc/sys/kernel/random/boot_id', 'utf8'), await readFile('/proc/1/stat', 'utf8'));
}
