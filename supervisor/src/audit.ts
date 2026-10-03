import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ActionDetail } from '../../shared/supervisor.js';
/** Read ids in one pass and repair an unfinished final row before any append. */
export async function auditedIds(stateDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const path = join(stateDir, 'audit.jsonl');
  const input = createReadStream(path);
  let bytes = 0; let lastNewline = 0; let validRow = false;
  input.on('data', chunk => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const newline = buffer.lastIndexOf(10);
    if (newline >= 0) lastNewline = bytes + newline + 1;
    bytes += buffer.length;
  });
  const rows = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const row of rows) {
      validRow = false;
      try { const id = (JSON.parse(row) as { id?: unknown })?.id; validRow = true; if (typeof id === 'string') ids.add(id); } catch {}
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  finally { rows.close(); input.destroy(); }
  if (bytes > lastNewline) {
    const file = await open(path, 'r+');
    try {
      // A complete JSON row can lose just its newline; keep it and separate the next append.
      if (validRow) await file.write('\n', bytes, 'utf8');
      else await file.truncate(lastNewline);
      await file.sync();
    } finally { await file.close(); }
  }
  return ids;
}
/** One line per action. Pass `audited` when checking many actions, so the log is read once, not once each. */
export async function audit(stateDir: string, action: ActionDetail, audited?: Set<string>): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if ((audited ?? await auditedIds(stateDir)).has(action.id)) return;
  await appendFile(join(stateDir, 'audit.jsonl'), JSON.stringify({ id: action.id, time: new Date().toISOString(), caller: action.caller, verb: action.verb, target: action.target, profile: action.profile ?? null, outcome: action.state }) + '\n', { mode: 0o600 });
  audited?.add(action.id);
}
