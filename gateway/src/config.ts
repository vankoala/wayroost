import { constants, watch, type FSWatcher } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { roleMapSchema, gatewayRepointBodySchema, type RoleMap, type Backend as SharedBackend } from '../../shared/gateway.js';
import { CREDENTIAL_EXPOSED, ownedPrivately, TrustedDirectory, WRITABLE_BY_OTHERS } from './directory.js';
export { CREDENTIAL_EXPOSED, ownedPrivately, WRITABLE_BY_OTHERS } from './directory.js';

export const ROLES = ['main', 'coder', 'fast'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_PORTS: Record<Role, number> = { main: 18010, coder: 18011, fast: 18012 };

export type Backend = SharedBackend;
export type GatewayConfig = RoleMap;

export class ConfigError extends Error {
  constructor() { super('Invalid gateway config. Check the schema in gateway/README.md.'); }
}

/** True when the path lies strictly inside the directory, compared after normalization. */
export function inside(directory: string, path: string): boolean {
  return path === resolve(path) && path.startsWith(`${resolve(directory)}${sep}`);
}

/** Validate all current and profile mappings against their contracts; credentials are catalogue names only. */
export function parseConfig(input: unknown, credentialsDirectory?: string): GatewayConfig {
  const result = roleMapSchema.safeParse(input);
  if (!result.success) throw new ConfigError();
  for (const backend of Object.values(result.data.backends)) {
    backend.baseUrl = new URL(backend.baseUrl).href.replace(/\/+$/, '');
  }
  return result.data;
}

export async function readLimitedFile(path: string, limit: number, forbidden?: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('Not a regular file.');
    if (forbidden !== undefined && !ownedPrivately(stats, forbidden)) throw new Error('File is not private.');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('File is too large.');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

export class ConfigStore {
  private config: GatewayConfig;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  private constructor(readonly path: string, config: GatewayConfig, private readonly onReload: (ok: boolean) => void,
    readonly directory: TrustedDirectory, private readonly credentialsDirectory?: string) {
    this.config = config;
  }

  static async load(path: string, onReload: (ok: boolean) => void = () => {}, credentialsDirectory?: string): Promise<ConfigStore> {
    const absolute = resolve(path);
    let directory: TrustedDirectory | undefined;
    try {
      directory = await TrustedDirectory.open(dirname(absolute));
      const config = await ConfigStore.read(directory, basename(absolute), credentialsDirectory);
      return new ConfigStore(absolute, config, onReload, directory, credentialsDirectory);
    } catch { await directory?.close(); throw new ConfigError(); }
  }

  /** Only the gateway's user or root may be able to change the mapping, through the file or its directory. */
  private static async read(directory: TrustedDirectory, name: string, credentialsDirectory?: string): Promise<GatewayConfig> {
    try {
      await directory.assertValid();
      const config = parseConfig(JSON.parse((await readLimitedFile(directory.entry(name), 128 * 1024, WRITABLE_BY_OTHERS)).toString('utf8')),
        credentialsDirectory);
      await directory.assertValid();
      return config;
    } catch { throw new ConfigError(); }
  }

  snapshot(): GatewayConfig { return structuredClone(this.config); }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  reload(): Promise<void> {
    return this.serialize(async () => {
      try {
        const config = await ConfigStore.read(this.directory, basename(this.path), this.credentialsDirectory);
        if (!this.stopped) { this.config = config; this.onReload(true); }
      } catch { this.onReload(false); throw new ConfigError(); }
    });
  }

  watch(): void {
    // Watch the directory so an atomic rename does not detach the watcher.
    this.watcher = watch(this.directory.anchoredPath, (_event, filename) => {
      if (filename !== null && String(filename) !== basename(this.path)) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.reload().catch(() => {}); }, 40);
      this.timer.unref();
    });
    this.watcher.on('error', () => this.onReload(false));
  }

  repoint(role: Role, input: unknown): Promise<void> {
    return this.serialize(async () => {
      const body = gatewayRepointBodySchema.safeParse({ backend: input });
      if (!body.success) throw new ConfigError();
      const next = parseConfig({ ...this.config, roles: { ...this.config.roles, [role]: body.data.backend } }, this.credentialsDirectory);
      await this.persist(next);
    });
  }

  selectProfile(key: string): Promise<void> {
    return this.serialize(async () => {
      const mapping = Object.hasOwn(this.config.profiles, key) ? this.config.profiles[key] : undefined;
      if (!mapping) throw new ConfigError();
      await this.persist(parseConfig({ ...this.config, roles: mapping }, this.credentialsDirectory));
    });
  }

  private async persist(next: GatewayConfig): Promise<void> {
    if (this.stopped) throw new Error('Config store is closed.');
    await this.directory.assertValid();
    const temporary = this.directory.entry(`${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await this.directory.assertValid();
      await rename(temporary, this.directory.entry(basename(this.path)));
      await this.directory.assertValid();
      this.config = next;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    await this.queue;
    await this.directory.close();
  }
}

/** Reads a backend key through its pinned directory, never through symlinks or untrusted ancestors. */
export async function readCredential(file: string, credentialsDirectory: string | TrustedDirectory | undefined): Promise<string> {
  const path = typeof credentialsDirectory === 'string' ? credentialsDirectory : credentialsDirectory?.path;
  if (path === undefined || !inside(path, file)) throw new Error('Credential unavailable.');
  const directory = typeof credentialsDirectory === 'string' ? await TrustedDirectory.open(path) : credentialsDirectory!;
  let parent = directory;
  try {
    await directory.assertValid();
    const subdirectory = dirname(relative(path, file));
    if (subdirectory !== '.') parent = await directory.child(subdirectory);
    const key = (await readLimitedFile(parent.entry(basename(file)), 8192, CREDENTIAL_EXPOSED)).toString('utf8').trim();
    await parent.assertValid();
    return key;
  } finally {
    if (parent !== directory) await parent.close();
    if (typeof credentialsDirectory === 'string') await directory.close();
  }
}
