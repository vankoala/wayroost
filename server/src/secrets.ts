import { checkDeviceSignal } from './security/device-signal.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { shadowBackground, type BackgroundGate } from './background.js';

// Credentials entered in the UI live only on this machine, in the service's
// private state directory, readable by the service user alone.

const HermesCredentialsSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

export type HermesCredentials = z.infer<typeof HermesCredentialsSchema>;

export class SecretStore {
  constructor(private readonly dir: string) {}

  private get hermesPath(): string {
    return join(this.dir, 'hermes-credentials.json');
  }

  readHermes(): HermesCredentials | null {
    let text: string;
    try {
      text = readFileSync(this.hermesPath, 'utf8');
    } catch {
      return null;
    }
    try {
      return HermesCredentialsSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  writeHermes(credentials: HermesCredentials): void {
    checkDeviceSignal();
    const value = HermesCredentialsSchema.parse(credentials);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.hermesPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, this.hermesPath);
  }

  clearHermes(): void {
    checkDeviceSignal();
    rmSync(this.hermesPath, { force: true });
  }
}

/** A stable id for this app's Paseo session (Paseo groups sockets by client id). */
export function readOrCreateClientId(dir: string, background: BackgroundGate = shadowBackground): string {
  const path = join(dir, 'paseo-client-id');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^cid_[a-z0-9_]{8,64}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const id = `cid_signalbox_${randomBytes(8).toString('hex')}`;
  background.run(() => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, id, { mode: 0o600 });
  });
  return id;
}
