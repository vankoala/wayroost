// M1 diagnostics: versions, unit states and health results as one JSON object.
// Never log contents — progress output belongs to actions.
import packageInfo from '../../package.json' with { type: 'json' };
import { unitArgv } from './unit.js';
import { probe, type Exec } from './probes.js';
import type { Component } from './registry.js';

/** `signal` ends every query and probe still running and stops the rest from starting. */
export async function collectDiagnostics(registry: Component[], exec: Exec, signal?: AbortSignal): Promise<unknown> {
  const components = [];
  for (const entry of registry) {
    signal?.throwIfAborted();
    let unitState: string | null = null;
    if (entry.unit && (entry.unit.scope !== 'user' || entry.unit.user)) {
      const lines: string[] = [];
      await exec.run(unitArgv(entry.unit, 'is-active'), line => { lines.push(line); }, { signal });
      unitState = lines[0] ?? 'unknown';
    }
    const health = entry.profiles
      ? Object.fromEntries(await Promise.all(entry.profiles.map(async profile =>
        [profile.id, (await probe(profile.health, exec, false, signal)) ? 'ok' : 'no answer'])))
      : entry.health.kind === 'none' ? 'not probed' : (await probe(entry.health, exec, false, signal)) ? 'ok' : 'no answer';
    components.push({ id: entry.id, name: entry.name, unit: entry.unit?.name ?? null, unitState, health });
  }
  return { versions: { node: process.version, supervisor: packageInfo.version }, components };
}
