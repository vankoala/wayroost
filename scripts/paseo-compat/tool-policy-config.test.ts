import { ProviderOverridesSchema } from '@getpaseo/protocol/provider-config';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_TOOLS, type PaseoToolsPolicy, type Providers } from '../../server/src/paseo/safety-config.js';
import { checkPluginToolLimits } from './tool-policy-config.js';

const legacy = z.object({ agents: z.object({ providers: ProviderOverridesSchema }) });
const overrides = z.object({ agents: z.object({ providers: z.record(z.string(), z.object({
  paseoTools: z.object({ disabledTools: z.array(z.string()) }),
})) }) });
function runtime() {
  return {
    resolvePaseoToolPolicy: vi.fn((id: string, providers: Providers) => providers[id]?.paseoTools),
    isPaseoToolEnabled: vi.fn((policy: PaseoToolsPolicy | undefined, tool: string) => policy?.enabled !== false && !policy?.disabledTools?.includes(tool)),
  };
}

describe('plugin tool limit compatibility', () => {
  it('detects rejection by the pinned Paseo schema without using its runtime', () => {
    const policy = runtime();
    expect(checkPluginToolLimits(legacy, policy)).toBe('rejected');
    expect(policy.resolvePaseoToolPolicy).not.toHaveBeenCalled();
    expect(policy.isPaseoToolEnabled).not.toHaveBeenCalled();
  });

  it('checks preserved limits and runtime enforcement when the schema accepts overrides', () => {
    const policy = runtime();
    expect(checkPluginToolLimits(overrides, policy)).toBe('accepted');
    expect(policy.resolvePaseoToolPolicy).toHaveBeenCalledWith('example-plugin', {
      'example-plugin': { paseoTools: { disabledTools: [...APPROVAL_TOOLS] } },
    });
    expect(policy.isPaseoToolEnabled.mock.calls.map(([, tool]) => tool)).toEqual([...APPROVAL_TOOLS, 'create_agent']);
  });

  it('fails when rejection is unrelated to the missing provider definition', () => {
    const schema = { safeParse: () => ({ success: false as const, error: { issues: [{ path: ['agents'], message: 'Invalid config' }] } }) };
    expect(() => checkPluginToolLimits(schema, runtime())).toThrow('missing provider definition');
  });

  it('fails when parsing silently drops the plugin limits', () => {
    const schema = { safeParse: () => ({ success: true as const, data: { agents: { providers: { 'example-plugin': {} } } } }) };
    expect(() => checkPluginToolLimits(schema, runtime())).toThrow('preserve a limit-only plugin override');
  });

  it('fails when the runtime does not resolve the plugin limits', () => {
    const policy = runtime();
    policy.resolvePaseoToolPolicy.mockReturnValue(undefined);
    expect(() => checkPluginToolLimits(overrides, policy)).toThrow('resolve the plugin override');
  });

  it.each(APPROVAL_TOOLS)('fails when the runtime still allows %s', tool => {
    const policy = runtime();
    const enabled = policy.isPaseoToolEnabled.getMockImplementation()!;
    policy.isPaseoToolEnabled.mockImplementation((limits, name) => name === tool || enabled(limits, name));
    expect(() => checkPluginToolLimits(overrides, policy)).toThrow(`${tool} must be disabled`);
  });

  it('fails when the runtime disables unrelated tools', () => {
    const policy = runtime();
    policy.isPaseoToolEnabled.mockReturnValue(false);
    expect(() => checkPluginToolLimits(overrides, policy)).toThrow('unrelated tools must remain enabled');
  });
});
