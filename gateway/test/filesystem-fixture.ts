import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { vi } from 'vitest';

export function fileIdentity(stats: Stats): string { return `${stats.dev}:${stats.ino}`; }

/** Model trusted host ancestors when the sandbox exposes its filesystem root with an unmapped UID. */
export async function directoryMetadata(): Promise<Map<string, number>> {
  const owners = new Map<string, number>();
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  const root = await actual.lstat('/');
  if (root.uid === 65534) owners.set(fileIdentity(root), 0);
  const adjust = (stats: Stats) => {
    const uid = owners.get(fileIdentity(stats));
    if (uid !== undefined) stats.uid = uid;
    return stats;
  };
  vi.mocked(fs.lstat).mockImplementation(async path => adjust(await actual.lstat(path)));
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    const stat = file.stat.bind(file);
    vi.spyOn(file, 'stat').mockImplementation(async () => adjust(await stat()));
    return file;
  });
  return owners;
}

export async function rootGateway(owners: Map<string, number>, paths: string[]): Promise<void> {
  for (const path of paths) {
    for (let current = resolve(path);; current = dirname(current)) {
      owners.set(fileIdentity(await fs.lstat(current)), 0);
      if (current === '/') break;
    }
  }
  vi.spyOn(process, 'getuid').mockReturnValue(0);
}
