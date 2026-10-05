import { loadConfig } from './config.js';
import { loadRegistry } from './registry.js';
import { loadKeys } from './keys.js';
import { realExec } from './probes.js';
import { createSupervisor } from './server.js';
import { trustedExecutable } from './trust.js';
import { ConfigVerbs } from './config-verbs.js';
import { configuredPaseoReload } from './config-paseo.js';
const config = await loadConfig();
const supervisor = createSupervisor({ config, registry: await loadRegistry(config.registryOverrides, config.adopt, config.development ? undefined : trustedExecutable), keys: await loadKeys(config.keysFile), exec: realExec,
  configVerbs: new ConfigVerbs({ stateDir: config.stateDir, reloadPaseo: await configuredPaseoReload() }) });
await supervisor.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void supervisor.close(); });
