import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { BackgroundGate } from '../background.js';
import { parseConfig, resolveRole } from '../config.js';
import { createSafetyDaemon } from './safety-daemon.js';
import { startSafetyRpc } from './safety-rpc.js';
import { WorkerApprovalsSetting } from './safety-setting.js';

// An owner-side service; every target is fixed by root-owned unit configuration.
function path(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`Missing absolute ${name}.`);
  return value;
}
const helperConfig = z.object({ configPath: z.string().refine(isAbsolute), url: z.string() }).strict()
  .parse(JSON.parse(readFileSync(path('WAYROOST_SAFETY_CONFIG'), 'utf8')));
const configPath = helperConfig.configPath;
const stateDir = path('STATE_DIRECTORY');
const socketPath = path('WAYROOST_SAFETY_SOCKET');
const credentials = path('CREDENTIALS_DIRECTORY');
const key = readFileSync(join(credentials, 'safety-helper-key'), 'utf8').trim();
let password: string | undefined;
try { password = readFileSync(join(credentials, 'paseo-password'), 'utf8').trim() || undefined; }
catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
if (password && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(password)) throw new Error('Invalid Paseo password credential.');
const url = helperConfig.url;
// Only the Paseo URL is checked here, by the server's own rules; the role is the helper's own.
parseConfig({ origins: ['http://127.0.0.1:8881'], stateDir, paseo: { url } }, { env: {} });
// Serving a shadow server (its unit sets WAYROOST_ROLE=shadow), the helper changes the owner's
// Paseo config only on a person's deliberate change (the Safety setting or a cloud-agent
// switch), never on its own at startup or on a timer.
const background = new BackgroundGate(resolveRole('primary', process.env));
const setting = new WorkerApprovalsSetting(configPath, stateDir, createSafetyDaemon(url, password));
const reconcile = () => setting.reconcile().catch(() => console.error('The Safety policy could not be saved.'));
await background.run(reconcile);
const rpc = await startSafetyRpc(socketPath, key, setting);
let reconciling = false;
const timer = background.run(() => setInterval(() => {
  if (reconciling) return;
  reconciling = true;
  void reconcile().finally(() => { reconciling = false; });
}, 5_000));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (timer) clearInterval(timer);
  rpc.close(() => process.exit(0));
});
