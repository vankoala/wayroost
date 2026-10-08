import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVAL_TOOLS, applyApprovalsToMe, undoApprovalsToMe, withRoleProviders, type PaseoToolsPolicy, type Providers } from '../../server/src/paseo/safety-config.js';

interface Config {
  agents?: { providers?: Providers };
}
interface ConfigSchema {
  safeParse(value: unknown):
    | { success: true; data: Config }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}
interface ToolPolicyRuntime {
  resolvePaseoToolPolicy(id: string, providers: Providers): PaseoToolsPolicy | undefined;
  isPaseoToolEnabled(policy: PaseoToolsPolicy | undefined, tool: string): boolean;
}

/** Probe the installed schema, then verify accepted overrides retain and enforce every limit. */
export function checkPluginToolLimits(schema: ConfigSchema, runtime: ToolPolicyRuntime): 'accepted' | 'rejected' {
  const limits = { disabledTools: [...APPROVAL_TOOLS] };
  const parsed = schema.safeParse({ version: 1, agents: { providers: { 'example-plugin': { paseoTools: limits } } } });
  if (!parsed.success) {
    assert(parsed.error.issues.some(issue => issue.path.includes('example-plugin') &&
      (issue.path.includes('extends') || issue.path.includes('label'))), 'plugin override must be rejected for its missing provider definition');
    return 'rejected';
  }
  const providers = parsed.data.agents?.providers ?? {};
  assert.deepEqual(providers['example-plugin'], { paseoTools: limits }, 'the schema must preserve a limit-only plugin override');
  const policy = runtime.resolvePaseoToolPolicy('example-plugin', providers);
  assert.deepEqual(policy, limits, 'the runtime must resolve the plugin override by provider id');
  for (const tool of APPROVAL_TOOLS) assert.equal(runtime.isPaseoToolEnabled(policy, tool), false, `${tool} must be disabled`);
  assert.equal(runtime.isPaseoToolEnabled(policy, 'create_agent'), true, 'unrelated tools must remain enabled');
  return 'accepted';
}

/** Config and registry checks can also run without starting a daemon or an agent process. */
export async function checkToolPolicyConfig(serverDir: string, pass: (condition: boolean, message: string) => void): Promise<void> {
  const load = (path: string) => import(pathToFileURL(path).href);
  const { PersistedConfigSchema, loadPersistedConfig } = await load(join(serverDir, 'dist/server/server/persisted-config.js'));
  const runtime = await load(join(serverDir, 'dist/server/server/agent/paseo-tool-policy.js'));
  const before = withRoleProviders({
    hermes: { extends: 'acp', label: 'Hermes', command: ['example-agent', 'acp'], paseoTools: { disabledTools: ['create_terminal'] } },
    claude: { paseoTools: { enabled: false } },
  });
  const on = applyApprovalsToMe(before);
  const off = undoApprovalsToMe(on.providers, on.backup);
  for (const providers of [before, on.providers, off]) PersistedConfigSchema.parse({ version: 1, agents: { providers } });
  pass(true, 'the role config, option on and off, is valid Paseo config.json');
  pass(JSON.stringify(off) === JSON.stringify(before), 'undo gives back config.json exactly as it was');

  const fromServer = createRequire(join(serverDir, 'package.json'));
  const logger = fromServer('pino')({ level: 'silent' });
  const directory = resolve('.tmp');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'paseo-config-'));
  try {
    for (const providers of [before, on.providers, off]) {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, agents: { providers } }), { mode: 0o600 });
      assert.deepEqual(loadPersistedConfig(root, logger).agents?.providers, providers, 'the config loader must retain the role policies');
    }
    pass(true, 'the config loader preserves the role policies with the option on and off');

    const behavior = checkPluginToolLimits(PersistedConfigSchema, runtime);
    pass(true, behavior === 'accepted'
      ? 'a limit-only plugin override is preserved and its approval tools are disabled'
      : 'a limit-only plugin override is rejected for its missing provider definition');
    if (behavior === 'rejected') return;

    const providers = { 'example-plugin': { paseoTools: { disabledTools: [...APPROVAL_TOOLS] } } };
    const { buildProviderRegistry } = await load(join(serverDir, 'dist/server/server/agent/provider-registry.js'));
    const plugin = {
      id: 'example-plugin', label: 'Example plugin', description: 'Example provider', defaultModeId: null, modes: [],
      supportsExactMcpPreapproval: false, createClient: () => ({ provider: 'example-plugin' }),
    };
    const registry = buildProviderRegistry(logger, { providerOverrides: providers, pluginProviders: { 'example-plugin': plugin } });
    pass(registry['example-plugin']?.label === plugin.label && registry['example-plugin']?.derivedFromProviderId === null,
      'a limit-only override keeps the registered plugin provider');
    pass(!Object.hasOwn(buildProviderRegistry(logger, { providerOverrides: providers }), 'example-plugin'),
      'an override without a registered plugin does not create a provider');

    writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, agents: { providers } }), { mode: 0o600 });
    const loaded = loadPersistedConfig(root, logger);
    assert.deepEqual(loaded.agents?.providers, providers, 'the config loader must preserve plugin tool limits');
    pass(true, 'the config loader preserves plugin tool limits');
    const disabled = { 'example-plugin': { paseoTools: { enabled: false } } };
    const parsed = PersistedConfigSchema.parse({ version: 1, agents: { providers: disabled } });
    pass(['create_agent', ...APPROVAL_TOOLS].every(tool => !runtime.isPaseoToolEnabled(runtime.resolvePaseoToolPolicy('example-plugin', parsed.agents.providers), tool)),
      'a plugin override can turn off Paseo agent tools');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
