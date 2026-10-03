// A Paseo daemon writes to your home whatever paseoHome says. At startup it keeps its
// orchestration skills in step under ~/.agents/skills, ~/.claude/skills and
// ~/.codex/skills (bootstrap.js orchestrationSkills.autoUpdate(); the folders come from
// os.homedir(), read on every call), repairing any that differ from its own copies, and
// the providers it starts read their own dot-folders. Before Paseo is loaded, the compat
// checks snapshot those folders of your real home, then hand the process to
// isolateDaemonEnv() (isolation.ts): it keeps only an allowlist of inherited variables on
// the original process.env and points HOME, USERPROFILE, the XDG folders, temp, Git config
// and PASEO_HOME into the temp root. So everything Paseo does in-process and every process
// it starts sees the temp home. Variables that name a path outright and don't follow HOME
// (CODEX_HOME and the other provider folder pointers, the targets of Paseo's debug output
// such as PASEO_GIT_TRACE_FILE, Git's trace targets, GIT_DIR and the like) are not on the
// allowlist, so they go; trace2 is switched off outright because the system git config can
// name a target as well. Afterwards the checks make sure nothing changed in those folders
// of your real home.
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateDaemonEnv, isolatedHome } from './isolation.js';

/** Folders of your home Paseo is known to write to. Only names and modification times are read. */
const WATCHED = ['.agents/skills', '.claude/skills', '.codex/skills'];
const MAX_ENTRIES = 50_000;
/** A Paseo skill planted in the temp home that differs from Paseo's own copy: its upkeep repairs it there. */
const PLANTED = join('.agents', 'skills', 'paseo', 'SKILL.md');
const STALE = 'Planted by the Signalbox compat check.\n';

/** path → modification time (or "absent"), for each watched folder and everything under it. */
function snapshot(home: string): Map<string, string> {
  const seen = new Map<string, string>();
  // The watched folders themselves may be links (to a shared skills folder): follow those, nothing below.
  const walk = (rel: string, follow: boolean) => {
    if (seen.size >= MAX_ENTRIES) return;
    let stat;
    try {
      stat = (follow ? statSync : lstatSync)(join(home, rel));
    } catch {
      seen.set(rel, 'absent');
      return;
    }
    seen.set(rel, String(stat.mtimeMs));
    if (!stat.isDirectory()) return;
    let names: string[] = [];
    try {
      names = readdirSync(join(home, rel));
    } catch {
      seen.set(rel, 'unreadable');
    }
    for (const name of names) walk(join(rel, name), false);
  };
  for (const rel of WATCHED) walk(rel, true);
  return seen;
}

/**
 * Moves this process (and everything it starts) to a home of its own under `root`.
 * Call it before Paseo is imported. The function it returns prints whether Paseo's skill
 * upkeep reached the temp home, and whether anything in the watched folders of your real
 * home changed since; it returns true if nothing did.
 */
export function isolateHome(root: string): () => boolean {
  const realHome = homedir();
  const before = snapshot(realHome); // before the environment changes
  const home = isolatedHome(root);
  mkdirSync(dirname(join(home, PLANTED)), { recursive: true });
  writeFileSync(join(home, PLANTED), STALE);
  isolateDaemonEnv(root);
  // The isolated folders exist before any daemon code runs.
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
    mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
  }
  if (homedir() !== home) throw new Error(`could not move HOME to ${home}`);

  return () => {
    let repaired: boolean;
    try {
      repaired = readFileSync(join(home, PLANTED), 'utf8') !== STALE;
    } catch {
      repaired = true; // replaced or removed: touched either way
    }
    // Versions without skill upkeep leave it alone; that isn't a failure.
    console.log(repaired ? "  ✓ Paseo's skill upkeep ran in the temp home (it repaired the planted skill)" : '  (Paseo left the skill planted in the temp home alone)');
    const after = snapshot(realHome);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((rel) => before.get(rel) !== after.get(rel));
    if (changed.length === 0) {
      console.log(`  ✓ nothing changed in your real ${WATCHED.map((w) => `~/${w}`).join(', ')}`);
      return true;
    }
    const shown = changed.slice(0, 10).map((rel) => `~/${rel}`).join(', ');
    console.error(`FAIL  changed in your real home while the check ran: ${shown}${changed.length > 10 ? ` and ${changed.length - 10} more` : ''}`);
    return false;
  };
}
