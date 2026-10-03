// The Paseo config patch behind "Workers' approvals come to me": it merges with what each
// provider already has off, and undo puts back exactly what was there.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TOOLS,
  BUILTIN_PROVIDER_IDS,
  ROLE_PROVIDERS,
  applyApprovalsToMe,
  undoApprovalsToMe,
  withRoleProviders,
  type Providers,
} from './safety-config.js';

const approval = [...APPROVAL_TOOLS];

/** A config.json agents.providers as someone might have it before Wayroost. */
function existing(): Providers {
  return {
    claude: { order: 1, paseoTools: { enabled: false } },
    codex: { paseoTools: { disabledTools: ['create_terminal'] } },
    hermes: { extends: 'acp', label: 'Hermes', command: ['hermes', 'acp'], env: { EXAMPLE: '1' } },
    opencode: { enabled: false },
  };
}

describe('applyApprovalsToMe', () => {
  it('takes respond_to_permission, set_agent_mode and update_agent from every provider', () => {
    const { providers } = applyApprovalsToMe(existing());
    for (const id of [...BUILTIN_PROVIDER_IDS, 'hermes']) {
      expect(providers[id]?.paseoTools?.disabledTools).toEqual(expect.arrayContaining(approval));
    }
    expect(approval).toContain('update_agent');
  });

  it("keeps a provider's tools off when they were off entirely", () => {
    const { providers } = applyApprovalsToMe(existing());
    expect(providers.claude).toEqual({ order: 1, paseoTools: { enabled: false, disabledTools: approval } });
  });

  it('adds to the tools a provider already has off instead of replacing them', () => {
    const { providers } = applyApprovalsToMe(existing());
    expect(providers.codex?.paseoTools).toEqual({ disabledTools: ['create_terminal', ...approval] });
  });

  it("leaves every other key of an entry alone, a custom provider's included", () => {
    const { providers } = applyApprovalsToMe(existing());
    expect(providers.hermes).toEqual({ ...existing().hermes, paseoTools: { disabledTools: approval } });
    expect(providers.opencode).toEqual({ enabled: false, paseoTools: { disabledTools: approval } });
  });

  it('gives built-ins without an entry one with only the limit', () => {
    const { providers, backup } = applyApprovalsToMe({});
    expect(providers.pi).toEqual({ paseoTools: { disabledTools: approval } });
    expect(backup.pi).toEqual({ entry: 'added', applied: { disabledTools: approval } });
  });

  it('does not list a tool twice when it was already off', () => {
    const { providers } = applyApprovalsToMe({ pi: { paseoTools: { disabledTools: ['update_agent'] } } });
    expect(providers.pi?.paseoTools?.disabledTools).toEqual(['update_agent', 'respond_to_permission', 'set_agent_mode']);
  });

  it('changes nothing it was given', () => {
    const before = existing();
    const copy = structuredClone(before);
    const on = applyApprovalsToMe(before);
    undoApprovalsToMe(on.providers, on.backup);
    expect(before).toEqual(copy);
  });
});

describe('undoApprovalsToMe', () => {
  it('puts config.json back exactly as it was, key order included', () => {
    const before = withRoleProviders(existing());
    const on = applyApprovalsToMe(before);
    const off = undoApprovalsToMe(on.providers, on.backup);
    expect(off).toEqual(before);
    expect(JSON.stringify(off)).toBe(JSON.stringify(before));
  });

  it('keeps the limits a provider had before the option', () => {
    const on = applyApprovalsToMe(existing());
    const off = undoApprovalsToMe(on.providers, on.backup);
    expect(off.claude?.paseoTools).toEqual({ enabled: false });
    expect(off.codex?.paseoTools).toEqual({ disabledTools: ['create_terminal'] });
    expect(off.hermes).not.toHaveProperty('paseoTools');
  });

  it('keeps a tool off that was off before the option, even one the option also turns off', () => {
    const before: Providers = { pi: { paseoTools: { disabledTools: ['update_agent'] } } };
    const on = applyApprovalsToMe(before);
    on.providers.pi = { paseoTools: { ...on.providers.pi?.paseoTools, enabled: false } }; // changed while on
    const off = undoApprovalsToMe(on.providers, on.backup);
    expect(off.pi?.paseoTools).toEqual({ disabledTools: ['update_agent'], enabled: false });
  });

  it('removes the entries the option added', () => {
    const on = applyApprovalsToMe(existing());
    const off = undoApprovalsToMe(on.providers, on.backup);
    expect(Object.keys(off).sort()).toEqual(Object.keys(existing()).sort());
  });

  it('keeps an entry the option added once something else was put in it', () => {
    const on = applyApprovalsToMe({});
    on.providers.pi = { ...on.providers.pi, order: 3 };
    expect(undoApprovalsToMe(on.providers, on.backup).pi).toEqual({ order: 3 });
  });

  it('only takes the option back out when the limits changed while it was on', () => {
    const on = applyApprovalsToMe(existing());
    const changed = { ...on.providers };
    changed.codex = { paseoTools: { disabledTools: [...(on.providers.codex?.paseoTools?.disabledTools ?? []), 'kill_agent'] } };
    changed.hermes = { ...on.providers.hermes, paseoTools: { enabled: false, disabledTools: approval } };
    const off = undoApprovalsToMe(changed, on.backup);
    expect(off.codex?.paseoTools).toEqual({ disabledTools: ['create_terminal', 'kill_agent'] });
    expect(off.hermes?.paseoTools).toEqual({ enabled: false });
  });

  it('skips a provider that was removed while the option was on', () => {
    const on = applyApprovalsToMe(existing());
    const { hermes: _gone, ...rest } = on.providers;
    expect(undoApprovalsToMe(rest, on.backup)).not.toHaveProperty('hermes');
  });
});

describe('re-applying after providers were added', () => {
  it('limits the new provider and keeps what was saved before the option first ran', () => {
    const before = existing();
    const first = applyApprovalsToMe(before);
    const grown = { ...first.providers, extra: { extends: 'pi', label: 'Extra', paseoTools: { disabledTools: ['kill_agent'] } } };
    const second = applyApprovalsToMe(grown, first.backup);
    expect(second.providers.extra?.paseoTools?.disabledTools).toEqual(['kill_agent', ...approval]);
    expect(second.providers.codex).toEqual(first.providers.codex);
    expect(second.backup.codex).toEqual(first.backup.codex);
    const off = undoApprovalsToMe(second.providers, second.backup);
    expect(off).toEqual({ ...before, extra: { extends: 'pi', label: 'Extra', paseoTools: { disabledTools: ['kill_agent'] } } });
  });

  it('keeps a limit added while the option was on through the re-apply and the undo', () => {
    const first = applyApprovalsToMe(existing());
    const edited = { ...first.providers, codex: { paseoTools: { disabledTools: [...(first.providers.codex?.paseoTools?.disabledTools ?? []), 'kill_agent'] } } };
    const second = applyApprovalsToMe(edited, first.backup);
    expect(second.backup.codex?.before).toEqual({ disabledTools: ['create_terminal', 'kill_agent'] });
    expect(undoApprovalsToMe(second.providers, second.backup).codex?.paseoTools).toEqual({ disabledTools: ['create_terminal', 'kill_agent'] });
  });

  it('starts over for a provider that was removed and added again', () => {
    const first = applyApprovalsToMe(existing());
    const { codex: _gone, ...rest } = first.providers;
    const second = applyApprovalsToMe({ ...rest, codex: { order: 2 } }, first.backup);
    expect(second.backup.codex?.entry).toBe('existing');
    expect(second.backup.codex?.before).toBeUndefined();
    expect(undoApprovalsToMe(second.providers, second.backup).codex).toEqual({ order: 2 });
  });
});

describe('withRoleProviders', () => {
  it('adds coder-lead, coder-worker and reviewer, each based on pi', () => {
    const providers = withRoleProviders({});
    expect(Object.keys(providers)).toEqual(Object.keys(ROLE_PROVIDERS));
    for (const [id, role] of Object.entries(ROLE_PROVIDERS)) {
      expect(providers[id]).toMatchObject({ extends: 'pi', label: role.label, description: role.description });
    }
  });

  it("turns Paseo's tools off for workers and reviewers, and leaves the lead its tools", () => {
    const providers = withRoleProviders({});
    expect(providers['coder-worker']?.paseoTools).toEqual({ enabled: false });
    expect(providers.reviewer?.paseoTools).toEqual({ enabled: false });
    expect(providers['coder-lead']).not.toHaveProperty('paseoTools');
  });

  it('keeps what an existing role entry has, apart from turning the tools off', () => {
    const providers = withRoleProviders({
      'coder-lead': { extends: 'acp', label: 'Lead', command: ['example-agent'], paseoTools: { disabledTools: ['kill_agent'] } },
      'coder-worker': { extends: 'pi', label: 'Worker', paseoTools: { enabled: true, disabledTools: ['create_agent'] } },
    });
    expect(providers['coder-lead']).toEqual({
      extends: 'acp',
      label: 'Lead',
      description: ROLE_PROVIDERS['coder-lead'].description,
      command: ['example-agent'],
      paseoTools: { disabledTools: ['kill_agent'] },
    });
    expect(providers['coder-worker']?.paseoTools).toEqual({ enabled: false, disabledTools: ['create_agent'] });
  });

  it('with the option on, the lead keeps create_agent and the workers stay off', () => {
    const { providers } = applyApprovalsToMe(withRoleProviders({}));
    expect(providers['coder-lead']?.paseoTools).toEqual({ disabledTools: approval });
    expect(providers['coder-worker']?.paseoTools).toEqual({ enabled: false, disabledTools: approval });
  });
});

describe('provider ids that are also names on every object', () => {
  // "constructor" matches Paseo's provider id pattern, and every object inherits a
  // constructor property: only a provider's own entry or backup may count.
  const custom = (): Providers => ({ constructor: { extends: 'pi', label: 'Example', paseoTools: { disabledTools: ['update_agent'] } } });

  it("keeps a 'constructor' provider's own limits in the backup on the first apply", () => {
    const on = applyApprovalsToMe(custom());
    expect(on.backup.constructor).toEqual({ entry: 'existing', before: { disabledTools: ['update_agent'] }, applied: { disabledTools: ['update_agent', 'respond_to_permission', 'set_agent_mode'] } });
    expect(undoApprovalsToMe(on.providers, on.backup)).toEqual(custom());
  });

  it("does not bring back a 'constructor' provider removed while the option was on", () => {
    const on = applyApprovalsToMe(custom());
    const { constructor: _gone, ...rest } = on.providers;
    const off = undoApprovalsToMe(rest, on.backup);
    expect(Object.hasOwn(off, 'constructor')).toBe(false);
    expect(Object.keys(off)).not.toContain('constructor');
  });
});
