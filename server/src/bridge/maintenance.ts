import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UserFacingError } from '../sources.js';

export const MAINTENANCE_MESSAGE = 'Maintenance: new work paused. Try again after the owner releases the hold.';
export const MAINTENANCE_FILE = 'bridge-maintenance.json';
const State = z.object({ version: z.literal(1), held: z.boolean(), heldAt: z.number().finite().optional(),
  admissionEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict();

export class MaintenanceError extends UserFacingError {
  readonly code = 'maintenance';
  constructor() { super(MAINTENANCE_MESSAGE, 503); }
}

/** A separate admission hold: existing waits and queued deliveries can still finish. */
export class MaintenanceHold {
  private held = false;
  private heldAt?: number;
  private admissionEpoch = 0;
  private heldEpoch?: number;
  private revision = 0;
  private readonly listeners = new Set<(held: boolean) => void>();

  constructor(readonly stateDir: string, private readonly now: () => number = Date.now) {
    try {
      const state = State.parse(JSON.parse(readFileSync(join(stateDir, MAINTENANCE_FILE), 'utf8')));
      this.held = state.held;
      this.heldAt = state.heldAt;
      this.admissionEpoch = state.admissionEpoch ?? 0;
      if (state.held) this.heldEpoch = state.admissionEpoch;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The bridge maintenance state could not be read.');
    }
  }

  isHeld(): boolean { return this.held; }
  get generation(): number { return this.revision; }
  /** Captured before starting backend work; a hold preserves this epoch for its later completion. */
  admit(): number {
    this.requireAdmission();
    return this.admissionEpoch;
  }
  requireAdmission(admittedAt?: number, admissionEpoch?: number): void {
    const ordered = admissionEpoch !== undefined && Number.isSafeInteger(admissionEpoch) && admissionEpoch >= 0
      && this.heldEpoch !== undefined && admissionEpoch <= this.heldEpoch;
    if (this.held && !ordered && !(admittedAt !== undefined && this.heldAt !== undefined && admittedAt < this.heldAt)) throw new MaintenanceError();
  }
  watch(listener: (held: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(held: boolean): { held: boolean } {
    const heldAt = held ? this.held ? this.heldAt : this.now() : undefined;
    const admissionEpoch = !held && this.held ? this.admissionEpoch + 1 : this.admissionEpoch;
    if (!Number.isSafeInteger(admissionEpoch)) throw new Error('The bridge admission epoch could not be advanced.');
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.stateDir, MAINTENANCE_FILE);
    const temp = `${path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, held, admissionEpoch, ...(heldAt !== undefined ? { heldAt } : {}) })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, path);
      renamed = true;
      const dir = openSync(this.stateDir, 'r');
      try { fsyncSync(dir); }
      finally { closeSync(dir); }
    } finally {
      rmSync(temp, { force: true });
      // After rename the visible file is authoritative, even if directory syncing failed.
      if (renamed) {
        this.admissionEpoch = admissionEpoch;
        this.heldEpoch = held ? admissionEpoch : undefined;
      }
      if (renamed && this.held !== held) {
        this.held = held;
        this.heldAt = heldAt;
        this.revision++;
      }
      if (renamed) for (const listener of this.listeners) listener(held);
    }
    return { held: this.held };
  }
}
