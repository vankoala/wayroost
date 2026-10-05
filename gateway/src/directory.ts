import { constants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const WRITABLE_BY_OTHERS = 0o022;
export const CREDENTIAL_EXPOSED = 0o026;

/** True when the file belongs to the gateway's user or root and has none of the forbidden mode bits. */
export function ownedPrivately(stats: Stats, forbidden: number): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && (stats.uid === uid || stats.uid === 0) && (stats.mode & forbidden) === 0;
}

type Identity = Pick<Stats, 'dev' | 'ino'>;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Linux directory handles keep file operations on the validated inode even if a path component is replaced. */
export class TrustedDirectory {
  private constructor(readonly path: string, private readonly file: FileHandle,
    private readonly identities: Identity[], private readonly forbidden: number) {}

  static async open(path: string, forbidden = WRITABLE_BY_OTHERS): Promise<TrustedDirectory> {
    if (process.platform !== 'linux' || !isAbsolute(path) || path !== resolve(path) || path.includes('\0')) {
      throw new Error('Directory must be a canonical absolute Linux path.');
    }
    let file = await open('/', DIRECTORY_FLAGS);
    const identities: Identity[] = [];
    const parts = path.split('/').filter(Boolean);
    try {
      for (let index = 0; index <= parts.length; index++) {
        const stats = await file.stat();
        if (!stats.isDirectory() || !ownedPrivately(stats, index === parts.length ? forbidden : WRITABLE_BY_OTHERS)) {
          throw new Error('Directory or ancestor is not trusted.');
        }
        identities.push({ dev: stats.dev, ino: stats.ino });
        if (index < parts.length) {
          const next = await open(`/proc/self/fd/${file.fd}/${parts[index]}`, DIRECTORY_FLAGS);
          await file.close();
          file = next;
        }
      }
      return new TrustedDirectory(path, file, identities, forbidden);
    } catch (error) { await file.close(); throw error; }
  }

  entry(name: string): string {
    if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new Error('Invalid directory entry.');
    return `/proc/self/fd/${this.file.fd}/${name}`;
  }

  get anchoredPath(): string { return `/proc/self/fd/${this.file.fd}`; }

  async assertValid(): Promise<void> {
    const current = await TrustedDirectory.open(this.path, this.forbidden);
    try {
      if (current.identities.length !== this.identities.length || this.identities.some((identity, index) => {
        const actual = current.identities[index];
        return actual?.dev !== identity.dev || actual.ino !== identity.ino;
      })) throw new Error('Directory identity changed.');
      if (!ownedPrivately(await this.file.stat(), this.forbidden)) throw new Error('Directory is no longer trusted.');
    } finally { await current.close(); }
  }

  async child(relative: string): Promise<TrustedDirectory> {
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
      throw new Error('Invalid credential directory.');
    }
    let file: FileHandle | undefined;
    const identities = [...this.identities];
    try {
      for (const part of parts) {
        const next = await open(`${file ? `/proc/self/fd/${file.fd}` : this.anchoredPath}/${part}`, DIRECTORY_FLAGS);
        if (file) await file.close();
        file = next;
        const stats = await file.stat();
        if (!stats.isDirectory() || !ownedPrivately(stats, WRITABLE_BY_OTHERS)) throw new Error('Credential directory is not trusted.');
        identities.push({ dev: stats.dev, ino: stats.ino });
      }
      return new TrustedDirectory(`${this.path}/${relative}`, file!, identities, WRITABLE_BY_OTHERS);
    } catch (error) { await file?.close(); throw error; }
  }

  async close(): Promise<void> { await this.file.close(); }
}
