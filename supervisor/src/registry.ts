// The component list, as data. Built-in entries are generic: no site paths.
// Anything that lives in a specific place (launcher scripts, hold files) comes
// from the adopt section of supervisor.json or from components.local.json.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Adopt } from './config.js';
import type { Trust } from './trust.js';
import { unitArgv, unitSchema, type Unit } from './unit.js';

const argv = z.array(z.string().min(1)).nonempty();
export const httpProbeSchema = z.object({
  kind: z.literal('http'), url: z.url(), timeoutMs: z.number().positive().default(2000),
  /** With busy probing: the count/boolean field in the JSON answer to read. */
  busyField: z.string().optional(),
}).strict();
export const probeSchema = z.discriminatedUnion('kind', [
  httpProbeSchema,
  z.object({
    kind: z.literal('unit'), command: argv,
    /** When set, the command must also print this line (e.g. LoadState "loaded"). */
    expect: z.string().min(1).optional(),
    /**
     * Installation probes with `expect`: the line that confirms the component is not
     * installed (LoadState "not-found"). Any other answer is unknown, never absent.
     */
    absent: z.string().min(1).optional(),
  }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export const profileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
  gpus: z.array(z.number().int().nonnegative()),
  loadSeconds: z.number().nonnegative().optional(),
  /** Each profile answers on its own URL; the live one is the one that answers. */
  health: httpProbeSchema,
  /** Filled from adopt.launchScript; switch-model runs it with the profile id. */
  argv: argv.optional(),
}).strict();
export const componentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1),
  /** systemd ownership; start/stop/restart argv is derived from it when unset. */
  unit: unitSchema.optional(),
  health: probeSchema, busy: probeSchema,
  gpus: z.array(z.number().int().nonnegative()),
  start: argv.optional(), stop: argv.optional(), restart: argv.optional(),
  holdFile: z.string().startsWith('/').optional(),
  /** Add-ons (the phone) stay out of status while they are not installed. */
  optional: z.boolean().optional(),
  installed: probeSchema.optional(),
  profiles: z.array(profileSchema).nonempty().optional(),
}).strict();
export type Component = z.infer<typeof componentSchema>;
export type Probe = z.infer<typeof probeSchema>;
export type Profile = z.infer<typeof profileSchema>;

export const NOT_SET_UP_SENTENCE = 'Not set up on this PC.';
/** Without its own restart argv, a profile component restarts whichever profile is live. */
export const restartsLiveProfile = (entry: Component): boolean => !entry.restart && Boolean(entry.profiles?.some(profile => profile.argv));
/** True when every verb the component advertises has a real argv behind it. */
export const isReady = (entry: Component): boolean => Boolean(entry.start && (entry.restart || restartsLiveProfile(entry)) &&
  (entry.unit?.scope !== 'user' || entry.unit.user));

const unit = (id: string, name: string, unitValue: Unit, extra: Partial<Component> = {}): Component => ({
  id, name, unit: unitValue,
  health: unitValue.scope === 'user' && !unitValue.user ? { kind: 'none' } : { kind: 'unit', command: unitArgv(unitValue, 'is-active', '--quiet') },
  busy: { kind: 'none' }, gpus: [],
  ...(unitValue.scope === 'user' && !unitValue.user ? {} : {
    start: unitArgv(unitValue, 'start'), stop: unitArgv(unitValue, 'stop'), restart: unitArgv(unitValue, 'restart'),
  }),
  ...extra,
});
const port = (value: number): string => 'http://127.0.0.1:' + value + '/health';
const modelProfile = (id: string, name: string, healthPort: number): Profile =>
  ({ id, name, gpus: [0], health: { kind: 'http', url: port(healthPort), timeoutMs: 2000 } });

export const BUILTIN_COMPONENTS: Component[] = [
  {
    id: 'main-model', name: 'Main model', health: { kind: 'none' }, busy: { kind: 'none' }, gpus: [0],
    profiles: [
      modelProfile('main-model', 'Main model', 19001),
      modelProfile('fast', 'Fast model', 19002),
      modelProfile('balanced', 'Balanced model', 19003),
      modelProfile('large', 'Large model', 19004),
    ],
  },
  { id: 'coder', name: 'Coder', health: { kind: 'http', url: port(19005), timeoutMs: 2000 }, busy: { kind: 'none' }, gpus: [1] },
  { id: 'paseo', name: 'Agent workspace', health: { kind: 'http', url: 'http://127.0.0.1:19007/api/health', timeoutMs: 2000 }, busy: { kind: 'none' }, gpus: [] },
  unit('hermes-dashboard', 'Agent dashboard', { name: 'demo-dashboard.service', scope: 'user' },
    { health: { kind: 'http', url: 'http://127.0.0.1:19006/api/status', timeoutMs: 2000 } }),
  unit('hermes-gateway', 'Agent gateway', { name: 'demo-gateway.service', scope: 'user' }),
  unit('signalbox', 'Chat relay', { name: 'signalbox.service', scope: 'system' }),
  unit('signalbox-tunnel', 'Remote access', { name: 'signalbox-tunnel.service', scope: 'system' }),
  unit('wayroost-server', 'Wayroost', { name: 'wayroost-server.service', scope: 'system' }),
  unit('helper', 'Helper', { name: 'signalbox-helper.service', scope: 'system' }),
  unit('speech', 'Speech', { name: 'signalbox-speech.service', scope: 'system' }),
  unit('phone', 'Phone line', { name: 'demo-phone.service', scope: 'user' }, { optional: true }),
  unit('keepalive', 'Keep awake', { name: 'wayroost-keepalive.service', scope: 'system' }),
];

// Adopt-mode verbs,: the launcher stays the source of truth.
const ADOPT_VERBS: Record<string, (entry: Component, adopt: Adopt) => Partial<Component> | undefined> = {
  // Restart has no fixed argv: it re-runs `launch.sh <live profile>` (see restartsLiveProfile).
  'main-model': (entry, adopt) => adopt.launchScript ? {
    start: [adopt.launchScript, entry.profiles![0]!.id], stop: [adopt.launchScript, 'stop-model'],
    profiles: entry.profiles!.map(profile => ({ ...profile, argv: profile.argv ?? [adopt.launchScript!, profile.id] })),
  } : undefined,
  'coder': (_entry, adopt) => adopt.coderScript && adopt.holdDir ? {
    start: [adopt.coderScript, 'coder'], stop: [adopt.coderScript, 'coder', 'stop'],
    restart: [adopt.coderScript, 'coder'], holdFile: join(adopt.holdDir, 'coder-hold'),
  } : undefined,
  'paseo': (_entry, adopt) => adopt.launchScript && adopt.holdDir ? {
    // The safe path: it takes the stack lock and never starts a second daemon.
    start: [adopt.launchScript, 'restart-paseo'],
    restart: [adopt.launchScript, 'restart-paseo'], holdFile: join(adopt.holdDir, 'paseo-hold'),
  } : undefined,
};

/** components.local.json entries: the same shape, patching an id or adding a full one. */
export const componentPatchSchema = componentSchema.partial().required({ id: true });
export type ComponentPatch = z.infer<typeof componentPatchSchema>;

/** Merge first, then derive commands so profiles and owners are the final ones. */
export function buildRegistry(adopt: Adopt = {}, overrides: ComponentPatch[] = []): Component[] {
  const entries = new Map(BUILTIN_COMPONENTS.map(entry => [entry.id, structuredClone(entry)]));
  for (const patch of overrides) {
    const previous = entries.get(patch.id);
    const merged: Record<string, unknown> = { ...previous, ...patch };
    if (patch.unit && (patch.unit.scope !== 'user' || patch.unit.user)) {
      // Re-derive whatever the patch did not set itself from the new unit.
      if (!patch.start) merged.start = unitArgv(patch.unit, 'start');
      if (!patch.stop) merged.stop = unitArgv(patch.unit, 'stop');
      if (!patch.restart) merged.restart = unitArgv(patch.unit, 'restart');
      if (!patch.health && (previous?.health.kind === 'unit' || previous?.health.kind === 'none' || !previous))
        merged.health = { kind: 'unit', command: unitArgv(patch.unit, 'is-active', '--quiet') };
    }
    entries.set(patch.id, componentSchema.parse(merged));
  }
  for (const entry of entries.values()) {
    const derived = ADOPT_VERBS[entry.id]?.(entry, adopt);
    if (derived) {
      const { start, stop, restart, holdFile } = entry;
      Object.assign(entry, derived, start ? { start } : {}, stop ? { stop } : {},
        restart ? { restart } : {}, holdFile ? { holdFile } : {});
    }
    // systemctl refuses `cat` through -M user@ ("Cannot remotely cat units"), so ask for LoadState.
    if (entry.optional && !entry.installed && entry.unit && (entry.unit.scope !== 'user' || entry.unit.user))
      // Masked, bad-setting and error LoadStates are not missing units: only not-found is.
      entry.installed = { kind: 'unit', command: unitArgv(entry.unit, 'show', '--property=LoadState', '--value'), expect: 'loaded', absent: 'not-found' };
  }
  return [...entries.values()];
}

export async function loadRegistry(path: string, adopt: Adopt = {}, trust?: Trust): Promise<Component[]> {
  if (trust) await trust(path);
  let overrides: unknown;
  try { overrides = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildRegistry(adopt); throw error; }
  return buildRegistry(adopt, z.array(componentPatchSchema.strict()).parse(overrides));
}
