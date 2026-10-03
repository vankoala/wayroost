import { checkDeviceSignal } from '../security/device-signal.js';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserFacingError } from '../sources.js';

const FILE = 'hermes-chat-moves.json';
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Hermes' explicit move reports, independent of the recent-chat list. */
export class ChatIdentity {
  readonly moves = new Map<string, string>();
  private readonly uncertain = new Set<string>();
  private durable = true;
  private unreadable = false;

  constructor(private readonly dir: string | null) {
    if (!dir) return;
    try {
      const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { moves?: unknown; uncertain?: unknown };
      if (!Array.isArray(raw.moves) || !Array.isArray(raw.uncertain)) throw new Error('invalid chat identity file');
      for (const pair of raw.moves) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((id) => typeof id === 'string' && CHAT_ID.test(id))) {
          throw new Error('invalid chat move');
        }
        if (this.moves.has(pair[0])) throw new Error('duplicate chat move');
        this.moves.set(pair[0], pair[1]);
      }
      for (const id of raw.uncertain) {
        if (typeof id !== 'string' || !CHAT_ID.test(id)) throw new Error('invalid uncertain chat');
        this.uncertain.add(id);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.durable = false;
        this.unreadable = true;
      }
    }
  }

  record(from: string, to: string): void {
    checkDeviceSignal();
    if (this.unreadable) throw new UserFacingError('Hermes chat identity could not be loaded.', 409);
    if (!CHAT_ID.test(from) || !CHAT_ID.test(to) || from === to) throw new UserFacingError('Invalid Hermes chat move.', 409);
    const previous = this.moves.get(from);
    if (previous === to && this.durable) return;
    if (previous && previous !== to) {
      // A repeated resume can skip hops that authoritative lineage already filled in.
      const seen = new Set([from]);
      let current: string | undefined = previous;
      while (current && !seen.has(current) && !this.uncertain.has(current)) {
        if (current === to) {
          if (!this.durable) this.save();
          return;
        }
        seen.add(current);
        current = this.moves.get(current);
      }
      this.uncertain.add(from);
      this.uncertain.add(previous);
      this.uncertain.add(to);
    } else {
      this.moves.set(from, to);
    }
    this.save();
  }

  /** Reconcile a complete authoritative lineage before changing or saving any hop. */
  recordLineage(ids: readonly string[]): void {
    checkDeviceSignal();
    if (this.unreadable) throw new UserFacingError('Hermes chat identity could not be loaded.', 409);
    if (ids.length < 2 || new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && CHAT_ID.test(id))) {
      throw new UserFacingError('Invalid Hermes chat lineage.', 409);
    }
    const positions = new Map(ids.map((id, i) => [id, i]));
    const moves = new Map(this.moves);
    for (let i = 0; i < ids.length - 1; i++) moves.set(ids[i]!, ids[i + 1]!);

    let conflict = false;
    const neighbors = new Map<string, Set<string>>();
    for (const [from, to] of [...this.moves, ...moves]) {
      const at = positions.get(from);
      // Existing shortcuts may skip forward, but cannot contradict or leave the complete lineage.
      if (at !== undefined && at < ids.length - 1 && (positions.get(to) ?? -1) <= at) conflict = true;
      if (!neighbors.has(from)) neighbors.set(from, new Set());
      if (!neighbors.has(to)) neighbors.set(to, new Set());
      neighbors.get(from)!.add(to);
      neighbors.get(to)!.add(from);
    }
    const component = new Set(ids);
    for (const id of component) {
      if (this.uncertain.has(id)) conflict = true;
      for (const neighbor of neighbors.get(id) ?? []) component.add(neighbor);
    }
    const parents = new Set<string>();
    for (const [from, to] of moves) {
      if (!component.has(from)) continue;
      if (parents.has(to)) conflict = true;
      parents.add(to);
    }
    const seen = new Set<string>();
    let current: string | undefined = ids[0];
    while (current) {
      if (seen.has(current)) { conflict = true; break; }
      seen.add(current);
      current = moves.get(current);
    }
    if (conflict) {
      for (const id of component) this.uncertain.add(id);
      this.save();
      throw new UserFacingError('Hermes chat identity is uncertain.', 409);
    }
    // Keep the Map object shared with the adapter; no partial lineage is ever published.
    this.moves.clear();
    for (const [from, to] of moves) this.moves.set(from, to);
    this.save();
  }

  private save(): void {
    checkDeviceSignal();
    if (!this.dir) return;
    // Persist Hermes move reports before a relay can act on their identity.
    this.durable = false;
    const path = join(this.dir, FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify({ moves: [...this.moves], uncertain: [...this.uncertain] }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.durable = true;
  }

  resolve(id: string): string {
    if (!this.durable) throw new UserFacingError('Hermes chat identity could not be saved or loaded.', 409);
    const seen = new Set<string>();
    let current = id;
    while (this.moves.has(current)) {
      if (seen.has(current) || this.uncertain.has(current)) throw new UserFacingError('Hermes chat identity is uncertain.', 409);
      seen.add(current);
      current = this.moves.get(current)!;
    }
    if (this.uncertain.has(current)) throw new UserFacingError('Hermes chat identity is uncertain.', 409);
    // A conflict upstream makes the whole recipient equivalence uncertain.
    for (const blocked of this.uncertain) {
      let next = blocked;
      const visited = new Set<string>();
      while (this.moves.has(next) && !visited.has(next)) {
        visited.add(next);
        next = this.moves.get(next)!;
      }
      if (next === current) throw new UserFacingError('Hermes chat identity is uncertain.', 409);
    }
    return current;
  }

  /** The original chat keeps the delivery budget through every continuation. */
  root(id: string): string {
    let current = this.resolve(id);
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) throw new UserFacingError('Hermes chat identity is uncertain.', 409);
      seen.add(current);
      const parents = [...this.moves].filter(([, to]) => to === current).map(([from]) => from);
      if (!parents.length) return current;
      if (parents.length !== 1) throw new UserFacingError('Hermes chat identity is uncertain.', 409);
      current = parents[0]!;
    }
  }
}
