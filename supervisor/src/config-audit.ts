import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { drainRunResult, configAuditRowSchema, configWriteResultSchema, credentialWriteResultSchema, drainRestartResultSchema, type ConfigAuditRow } from '../../shared/supervisor-config.js';
import { checkConfigDirectory, ConfigError } from './config-paths.js';
import { withSettingsFileLock } from '../../server/src/settings/write-through.js';

const requestRecordSchema = z.object({
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), callerSha256: z.string().regex(/^[a-f0-9]{64}$/),
  interrupted: z.literal(true).optional(), terminal: z.literal(true).optional(),
  row: configAuditRowSchema, result: configWriteResultSchema.optional(),
  credentialResult: credentialWriteResultSchema.optional(), drainResult: drainRestartResultSchema.optional(),
}).strict();
export type ConfigRequestRecord = z.infer<typeof requestRecordSchema>;
export const configRequestFinished = (record: ConfigRequestRecord): boolean => !!(record.terminal || record.result || record.credentialResult
  || record.drainResult && (!record.drainResult.ok || drainRunResult(record.drainResult.run) !== 'pending'));
const requestName = /^config-request-([a-f0-9-]{36})\.json$/i;

/** A separate, strict log preserves the lifecycle audit's existing format. */
export class ConfigAudit {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(readonly directory: string, private readonly uid = process.getuid!(),
    private readonly exit: (code: number) => void = code => process.exit(code)) {}
  private stop(): never {
    this.failed = true;
    this.exit(1);
    throw new ConfigError('audit_unavailable');
  }
  private async durable<T>(work: () => Promise<T>): Promise<T> {
    if (this.failed) throw new ConfigError('audit_unavailable');
    try { return await work(); } catch { return this.stop(); }
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    if (this.failed) throw new ConfigError('audit_unavailable');
    await this.storage();
    return withSettingsFileLock(join(this.directory, 'config-audit.lock'), work, 0, Date.now() + 5000);
  }
  private async storage(): Promise<void> {
    await checkConfigDirectory(this.directory, this.uid, true);
    await this.durable(() => mkdir(this.directory, { recursive: true, mode: 0o700 }));
    const directory = await lstat(this.directory);
    if (directory.uid !== this.uid || directory.mode & 0o077) throw new ConfigError('audit_unavailable');
  }
  private async file() {
    await this.storage();
    const file = await this.durable(() => open(join(this.directory, 'config-audit.jsonl'), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600));
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== this.uid || stat.nlink !== 1 || stat.mode & 0o077) { await file.close(); throw new ConfigError('audit_unavailable'); }
    return file;
  }
  private async syncDirectory(): Promise<void> {
    await this.durable(async () => {
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    });
  }

  private async logRows(file: FileHandle): Promise<ConfigAuditRow[]> {
    const source = await file.readFile('utf8');
    const end = source.lastIndexOf('\n') + 1;
    const rows = source.slice(0, end).split('\n').filter(Boolean).map(line => configAuditRowSchema.parse(JSON.parse(line)));
    if (end < source.length) {
      let row: ConfigAuditRow | undefined;
      try { row = configAuditRowSchema.parse(JSON.parse(source.slice(end))); } catch {}
      await this.durable(async () => {
        if (row) { rows.push(row); await file.writeFile('\n'); }
        else await file.truncate(Buffer.byteLength(source.slice(0, end)));
        await file.sync();
      });
    }
    return [...new Map(rows.map(row => [row.id, row])).values()];
  }

  async rows(): Promise<ConfigAuditRow[]> {
    const pending = this.queue.then(() => this.locked(async () => {
      const file = await this.file();
      try {
        const rows = new Map((await this.logRows(file)).map(row => [row.id, row]));
        // A saved launch remains auditable after an interrupted log append.
        for (const name of await readdir(this.directory)) {
          const id = requestName.exec(name)?.[1];
          if (!id) continue;
          const record = await this.readRequest(id);
          if (record && (record.result || record.credentialResult || record.drainResult || !rows.has(record.row.id))) rows.set(record.row.id, record.row);
        }
        return [...rows.values()];
      } finally { await file.close(); }
    })).catch(() => { throw new ConfigError('audit_unavailable'); });
    this.queue = pending.catch(() => {});
    return pending;
  }
  async append(row: ConfigAuditRow): Promise<void> {
    const pending = this.queue.then(() => this.locked(async () => {
      const file = await this.file();
      try {
        const rows = await this.logRows(file);
        const value = configAuditRowSchema.parse(row);
        const index = rows.findIndex(existing => existing.id === row.id);
        if (index < 0) {
          await this.durable(async () => { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); });
          await this.syncDirectory();
        } else if (!isDeepStrictEqual(rows[index], value)) {
          rows[index] = value;
          await this.publish('config-audit.jsonl', rows.map(item => JSON.stringify(item) + '\n').join(''));
        }
      }
      finally { await file.close(); }
    })).catch(() => { throw new ConfigError('audit_unavailable'); });
    this.queue = pending.catch(() => {});
    await pending;
  }

  async request(id: string): Promise<ConfigRequestRecord | undefined> {
    const pending = this.queue.then(() => this.locked(() => this.readRequest(id)));
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async readRequest(id: string): Promise<ConfigRequestRecord | undefined> {
    if (!z.uuid({ version: 'v4' }).safeParse(id).success) throw new ConfigError('invalid_parameters');
    await checkConfigDirectory(this.directory, this.uid, true);
    let file;
    try { file = await open(join(this.directory, `config-request-${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new ConfigError('audit_unavailable'); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== this.uid || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 1024 * 1024) throw new Error();
      const record = requestRecordSchema.parse(JSON.parse(await file.readFile('utf8')));
      if (record.row.id !== id) throw new Error();
      return record;
    } catch { throw new ConfigError('audit_unavailable'); }
    finally { await file.close(); }
  }

  /** Persist launch metadata first; success is final only after the log append. */
  async save(record: ConfigRequestRecord): Promise<void> {
    const value = requestRecordSchema.parse(record);
    const pending = this.queue.then(() => this.locked(async () => {
      const name = `config-request-${value.row.id}.json`;
      await this.publish(name, JSON.stringify(value) + '\n');
    }));
    this.queue = pending.catch(() => {});
    await pending;
  }

  private async publish(name: string, source: string): Promise<void> {
    await this.storage();
    const temporary = join(this.directory, `.config-request-${randomUUID()}`);
    try {
      const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(source); await output.sync(); }
      finally { await output.close(); }
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await rename(temporary, join(this.directory, name)); await directory.sync(); }
      finally { await directory.close(); }
    } catch { this.stop(); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  /** A launch without terminal evidence stays interrupted after startup. */
  async initialize(): Promise<void> {
    const pending = this.queue.then(() => this.locked(async () => {
      const file = await this.file();
      try {
        const rows = new Map((await this.logRows(file)).map(row => [row.id, row]));
        for (const name of await readdir(this.directory)) {
          const id = requestName.exec(name)?.[1];
          if (!id) continue;
          const record = await this.readRequest(id);
          if (!record || configRequestFinished(record) || record.interrupted) continue;
          const logged = rows.get(id);
          const terminal = logged?.result !== 'outcome_unknown' ? logged : undefined;
          await this.publish(name, JSON.stringify(terminal
            ? { ...record, row: terminal, terminal: true } : { ...record, interrupted: true }) + '\n');
        }
      } finally { await file.close(); }
    }));
    this.queue = pending.catch(() => {});
    await pending;
  }

  async reconcile(): Promise<void> {
    const pending = this.queue.then(() => this.locked(async () => {
      const file = await this.file();
      try {
        const rows = new Map((await this.logRows(file)).map(row => [row.id, row]));
        let changed = false;
        for (const name of await readdir(this.directory)) {
          const id = requestName.exec(name)?.[1];
          if (!id) continue;
          const record = await this.readRequest(id);
          if (!record) continue;
          if (!record.result && !record.credentialResult && !record.drainResult && rows.has(record.row.id)) continue;
          if (!isDeepStrictEqual(rows.get(record.row.id), record.row)) {
            rows.set(record.row.id, record.row); changed = true;
          }
        }
        if (changed) await this.publish('config-audit.jsonl', [...rows.values()].map(row => JSON.stringify(row) + '\n').join(''));
      } finally { await file.close(); }
    })).catch(() => { throw new ConfigError('audit_unavailable'); });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
