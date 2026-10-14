import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wayroost-names-'));
  folders.push(dir);
  const hermes = join(dir, 'config.yaml');
  const pi = join(dir, 'mcp.json');
  // Paseo's Claude harness consumes the user MCP map. No daemon/session store is read.
  const paseo = join(dir, '.claude.json');
  writeFileSync(hermes, `# invented owner fixture\nmcp_servers:\n  signalbox: # keep this comment\n    command: /demo/node\n    args: [/demo/signalbox-bridge.mjs]\n    env: {PASEO_AGENT_ID: "\${PASEO_AGENT_ID}", DEMO: yes}\n    timeout: 47\n    enabled: false\n  coder: {command: /demo/coder}\nplugins:\n  enabled: [other, signalbox-identity] # keep plugin comment\n  disabled: [unused]\nmodel: {name: demo}\n`);
  const entry = { command: '/demo/node', args: ['/demo/signalbox-bridge.mjs'], env: { DEMO: 'fixture' },
    directTools: false, toolPrefix: 'server', timeout: 37, disabledTools: ['start_chat'] };
  writeFileSync(pi, JSON.stringify({ mcpServers: { coder: { command: 'demo' }, signalbox: entry }, extra: [1, 2] }, null, 4));
  writeFileSync(paseo, JSON.stringify({ mcpServers: { signalbox: entry }, preferences: { fixture: true } }));
  const sentinel = join(dir, 'memories.json');
  writeFileSync(sentinel, '{"invented":"never read or changed"}');
  const pluginDir = join(dir, 'plugins', 'wayroost-identity');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.yaml'), 'name: wayroost-identity\n');
  const mirror = join(pluginDir, 'wayroost-bridge.json');
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ targets: [
    { kind: 'hermes', path: hermes, map: '/mcp_servers' },
    { kind: 'pi', path: pi, map: '/mcpServers' },
    { kind: 'paseo', path: paseo, map: '/mcpServers' },
  ], pluginMirror: mirror }));
  const receipt = join(dir, 'receipt.json');
  const paths = [hermes, pi, paseo, sentinel];
  paths.forEach(path => chmodSync(path, 0o640));
  const before = paths.map(path => readFileSync(path));
  const run = (verb: string, extra: string[] = []) => spawnSync('python3', ['-I', '-B', resolve('deploy/bridge-names.py'), verb,
    '--manifest', manifest, '--receipt', receipt, ...extra], { encoding: 'utf8' });
  return { dir, paths, before, hermes, pi, paseo, manifest, receipt, mirror, pluginDir, run };
}

function cronFixture(shape: string) {
  const f = fixture();
  const cronDir = join(f.dir, 'cron');
  mkdirSync(cronDir);
  const cron = join(cronDir, 'jobs.json');
  const jobs = [
    { id: 'fake-job-a', enabled_toolsets: ['signalbox'], prompt: 'example a' },
    { id: 'fake-job-b', enabled_toolsets: ['wayroost'], prompt: 'example b' },
  ];
  writeFileSync(cron, JSON.stringify(shape === 'array' ? jobs : { jobs }));
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'hermes', path: cron });
  writeFileSync(f.manifest, JSON.stringify(spec));
  return { ...f, cron };
}

it('plans without changes, preserves every registration field and exactly reverses all bytes/modes', () => {
  const f = fixture();
  expect(f.run('plan').status).toBe(0);
  expect(f.paths.map(path => readFileSync(path))).toEqual(f.before);
  expect(f.run('forward').status).toBe(0);
  const current = parse(readFileSync(f.hermes, 'utf8'));
  const original = parse(f.before[0]!.toString());
  expect(current.mcp_servers.wayroost).toEqual({ ...original.mcp_servers.signalbox,
    env: { ...original.mcp_servers.signalbox.env, WAYROOST_BRIDGE_NAME: 'wayroost' } });
  expect(current.mcp_servers.coder).toEqual(original.mcp_servers.coder);
  expect(current.plugins).toEqual({ enabled: ['other', 'wayroost-identity'], disabled: ['unused'] });
  expect(readFileSync(f.hermes, 'utf8')).toContain('wayroost: # keep this comment');
  expect(readFileSync(f.hermes, 'utf8')).toContain('# keep plugin comment');
  for (const [index, path] of [[1, f.pi], [2, f.paseo]] as const) {
    const expected = JSON.parse(f.before[index]!.toString());
    expected.mcpServers.wayroost = expected.mcpServers.signalbox;
    expected.mcpServers.wayroost.env.WAYROOST_BRIDGE_NAME = 'wayroost';
    delete expected.mcpServers.signalbox;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
  }
  expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
  expect(f.run('verify').status).toBe(0);
  const after = f.paths.map(path => readFileSync(path));
  expect(f.run('forward').status).toBe(0);
  expect(f.paths.map(path => readFileSync(path))).toEqual(after);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(f.paths.map(path => readFileSync(path))).toEqual(f.before);
  f.paths.forEach(path => expect(statSync(path).mode & 0o777).toBe(0o640));
  expect(f.run('forward').status).toBe(0);
});

it('renames supported allowlists and permission references in the same receipt', () => {
  const f = fixture();
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'platform_toolsets:\n  cron: [todo, signalbox]\n');
  const cronDir = join(f.dir, 'cron');
  mkdirSync(cronDir);
  const cron = join(cronDir, 'jobs.json');
  const settings = join(f.dir, 'settings.json');
  const opencode = join(f.dir, 'opencode.json');
  writeFileSync(cron, JSON.stringify({ jobs: [{ enabled_toolsets: ['todo', 'signalbox'], prompt: 'example' }] }));
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['mcp__signalbox__read_chat'], deny: ['mcp__signalbox__*'] } }));
  writeFileSync(opencode, JSON.stringify({ mcp: { signalbox: { type: 'local', command: ['node', '/demo/bridge.mjs'], environment: { DEMO: 'yes' } } },
    tools: { 'mcp__signalbox__*': false }, permission: { 'mcp__signalbox__send_message': 'deny' } }));
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'hermes', path: cron }, { kind: 'claude', path: settings },
    { kind: 'opencode', path: opencode, map: '/mcp' });
  writeFileSync(f.manifest, JSON.stringify(spec));
  const originals = [f.hermes, cron, settings, opencode].map(path => readFileSync(path));
  expect(f.run('forward').status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8')).platform_toolsets.cron).toEqual(['todo', 'wayroost']);
  expect(JSON.parse(readFileSync(cron, 'utf8')).jobs[0].enabled_toolsets).toEqual(['todo', 'wayroost']);
  expect(JSON.parse(readFileSync(settings, 'utf8')).permissions).toEqual({
    allow: ['mcp__wayroost__read_chat'], deny: ['mcp__wayroost__*'] });
  const renamed = JSON.parse(readFileSync(opencode, 'utf8'));
  expect(renamed.tools).toEqual({ 'mcp__wayroost__*': false });
  expect(renamed.permission).toEqual({ 'mcp__wayroost__send_message': 'deny' });
  expect(renamed.mcp.wayroost.environment).toEqual({ DEMO: 'yes', WAYROOST_BRIDGE_NAME: 'wayroost' });
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect([f.hermes, cron, settings, opencode].map(path => readFileSync(path))).toEqual(originals);
});

it.each(['>-', '|-'].flatMap(style => ['allowlist', 'enabled plugin', 'disabled plugin', 'registration key', 'stamp']
  .map(location => ({ style, location }))))('refuses $style scalar renames in $location before publication', ({ style, location }) => {
  const f = fixture();
  let text = readFileSync(f.hermes, 'utf8');
  if (location === 'allowlist') {
    text += `platform_toolsets:\n  cron:\n    - ${style} # keep scalar comment\n      signalbox\n    - todo\n`;
  } else if (location === 'enabled plugin') {
    text = text.replace('enabled: [other, signalbox-identity]', `enabled:\n    - ${style}\n      signalbox-identity\n    - other`);
  } else if (location === 'disabled plugin') {
    text = text.replace('enabled: [other, signalbox-identity]', 'enabled: [other]')
      .replace('disabled: [unused]', `disabled:\n    - ${style}\n      signalbox-identity\n    - unused`);
  } else if (location === 'registration key') {
    text = text.replace('  signalbox: # keep this comment', `  ? ${style}\n    signalbox\n  : # keep this comment`);
  } else {
    text = text.replace('    env: {PASEO_AGENT_ID: "${PASEO_AGENT_ID}", DEMO: yes}',
      `    env:\n      WAYROOST_BRIDGE_NAME: ${style}\n        signalbox\n      DEMO: yes`);
  }
  writeFileSync(f.hermes, text);
  const before = f.paths.map(path => readFileSync(path));
  for (const verb of ['plan', 'forward']) {
    const result = f.run(verb);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Block YAML scalar renames are unsupported at /');
    expect(f.paths.map(path => readFileSync(path))).toEqual(before);
    expect(existsSync(f.receipt)).toBe(false);
  }
});

it.each(['plugin', 'allowlist'])('refuses incorrect %s semantics in a receipt before publication', kind => {
  const f = fixture();
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'platform_toolsets: {cron: [signalbox, todo]}\n');
  const original = readFileSync(f.hermes, 'utf8');
  expect(f.run('forward').status).toBe(0);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  const file = receipt.files[0];
  const edit = file.edits.find((item: { start: number; after: string }) => kind === 'plugin'
    ? item.after === 'wayroost-identity' : item.start === original.lastIndexOf('signalbox'));
  edit.after = kind === 'plugin' ? 'other-identity' : 'other';
  const corrupted = file.edits.reduceRight((text: string, item: { start: number; before: string; after: string }) =>
    text.slice(0, item.start) + item.after + text.slice(item.start + item.before.length), original);
  file.afterHash = createHash('sha256').update(corrupted).digest('hex');
  writeFileSync(f.receipt, JSON.stringify(receipt));
  writeFileSync(f.hermes, original);
  const paths = [...f.paths, f.receipt];
  const before = paths.map(path => readFileSync(path));
  const result = f.run('forward');
  expect(result.status, result.stderr).toBe(1);
  expect(paths.map(path => readFileSync(path))).toEqual(before);
});

it.each(['plugin', 'allowlist'])('validates expected %s semantics before creating a migration receipt', kind => {
  const f = fixture();
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'platform_toolsets: {cron: [signalbox, todo]}\n');
  const before = f.paths.map(path => readFileSync(path));
  const script = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("bridge_names", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
apply = module.apply_edits
corruption = sys.argv[4]
def corrupt(raw, edits, reverse=False):
    output = apply(raw, edits, reverse)
    if corruption == "plugin":
        return output.replace(b"wayroost-identity", b"other-identity")
    return output.replace(b"[wayroost, todo]", b"[other, todo]")
module.apply_edits = corrupt
sys.argv = [sys.argv[1], "forward", "--manifest", sys.argv[2], "--receipt", sys.argv[3]]
module.main()
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', script, resolve('deploy/bridge-names.py'), f.manifest, f.receipt, kind],
    { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('Configuration span edit did not verify expected semantics');
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  expect(existsSync(f.receipt)).toBe(false);
});

it.each(['signalbox', 'wayroost', 'mcp__signalbox__read_chat', 'mcp__wayroost__*', 'signalbox_read_chat', 'wayroost_send_message'])(
  'refuses unsupported reference %s and reports only its JSON pointer', value => {
    const f = fixture();
    const data = JSON.parse(readFileSync(f.pi, 'utf8'));
    data.extra = { private: value, other: 'obviously-fake-private-setting' };
    writeFileSync(f.pi, JSON.stringify(data));
    const before = f.paths.map(path => readFileSync(path));
    const result = f.run('plan');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/extra/private');
    expect(result.stderr).not.toContain(value);
    expect(result.stderr).not.toContain('obviously-fake-private-setting');
    expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  });

it('verifies semantically and reverses current bytes while keeping later owner changes', () => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + '\n# later owner comment\nnew_setting: example\n');
  for (const path of [f.pi, f.paseo]) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.ownerCache = { value: 'new setting' };
    writeFileSync(path, JSON.stringify(data, null, 3) + '\n');
  }
  expect(f.run('verify').status).toBe(0);
  const current = [f.hermes, f.pi, f.paseo].map(path => readFileSync(path, 'utf8'));
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toContain('# later owner comment\nnew_setting: example');
  for (const [index, path] of [[1, f.pi], [2, f.paseo]] as const) {
    const result = readFileSync(path, 'utf8');
    expect(JSON.parse(result).ownerCache).toEqual({ value: 'new setting' });
    expect(result).toBe(current[index]!.replace('"wayroost":', '"signalbox":')
      .replace(/,\n +"WAYROOST_BRIDGE_NAME": "wayroost"/, ''));
  }
});

it.each(['paseo', 'settings', 'opencode'])('reverses only migrated %s permissions after unrelated writes', kind => {
  const f = fixture();
  const file = kind === 'paseo' ? f.paseo : join(f.dir, kind === 'settings' ? 'settings.json' : 'opencode.json');
  const data = kind === 'paseo' ? JSON.parse(readFileSync(file, 'utf8')) : kind === 'settings' ? {} : {
    mcp: { signalbox: { command: ['node', '/home/me/bridge.mjs'] } },
  };
  if (kind === 'opencode') {
    data.permission = { mcp__signalbox__read_chat: 'deny', mcp__wayroost__send_message: 'allow' };
  } else {
    data.permissions = { allow: ['mcp__signalbox__read_chat', 'mcp__wayroost__send_message', 'mcp__wayroost__read_chat'],
      deny: ['mcp__signalbox__*', 'mcp__wayroost__*'] };
  }
  writeFileSync(file, JSON.stringify(data));
  if (kind !== 'paseo') {
    const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
    spec.targets.push(kind === 'settings' ? { kind: 'claude', path: file } : { kind: 'opencode', path: file, map: '/mcp' });
    writeFileSync(f.manifest, JSON.stringify(spec));
  }
  expect(f.run('forward').status).toBe(0);
  const current = JSON.parse(readFileSync(file, 'utf8'));
  current.ownerCache = 'example';
  writeFileSync(file, JSON.stringify(current, null, 2));
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  const reversed = JSON.parse(readFileSync(file, 'utf8'));
  expect(reversed.ownerCache).toBe('example');
  if (kind === 'opencode') {
    expect(reversed.permission).toEqual(data.permission);
  } else {
    expect(reversed.permissions).toEqual(data.permissions);
  }
  const once = f.paths.map(path => readFileSync(path));
  expect(f.run('reverse').status).toBe(0);
  expect(f.paths.map(path => readFileSync(path))).toEqual(once);
});

it.each(['forward', 'reverse'])('refuses unsupported references in %s state before verification or publication', state => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  if (state === 'reverse') expect(f.run('reverse').status).toBe(0);
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.projects = { '/demo/project': { disabledMcpServers: [state === 'forward' ? 'wayroost' : 'signalbox'] } };
  writeFileSync(f.paseo, JSON.stringify(data));
  const before = f.paths.map(path => readFileSync(path));
  for (const [verb, extra] of [['verify', state === 'reverse' ? ['--expect', 'reverse'] : []], ['reverse', []], ['forward', []]] as const) {
    const result = f.run(verb, [...extra]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/projects/~1demo~1project/disabledMcpServers/0');
    expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  }
});

it('refuses moved permission references before undo can change unrelated rules', () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { allow: ['mcp__signalbox__read_chat', 'mcp__wayroost__send_message'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  data.mcpServers.wayroost = data.mcpServers.signalbox;
  data.mcpServers.wayroost.env.WAYROOST_BRIDGE_NAME = 'wayroost';
  delete data.mcpServers.signalbox;
  data.permissions.allow = ['mcp__wayroost__send_message', 'mcp__wayroost__read_chat'];
  writeFileSync(f.paseo, JSON.stringify(data));
  const before = f.paths.map(path => readFileSync(path));
  expect(f.run('verify').status).toBe(1);
  expect(f.run('reverse').status).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it.each(['allow', 'deny'])('refuses ambiguous deletion of migrated %s rules before publication', permission => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { [permission]: ['mcp__signalbox__send_message', 'mcp__wayroost__send_message'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  const current = JSON.parse(readFileSync(f.paseo, 'utf8'));
  current.permissions[permission].shift();
  writeFileSync(f.paseo, JSON.stringify(current));
  const before = f.paths.map(path => readFileSync(path));
  for (const verb of ['verify', 'reverse', 'forward']) {
    const result = f.run(verb);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`/permissions/${permission}`);
    expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  }
});

it.each(['delete', 'move'])('refuses ambiguous %s edits among identical permission rules', edit => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { allow: ['mcp__signalbox__send_message', 'mcp__wayroost__send_message', 'Read'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  const current = JSON.parse(readFileSync(f.paseo, 'utf8'));
  if (edit === 'delete') {
    current.permissions.allow.shift();
    current.permissions.allow.push('Write');
  } else {
    current.permissions.allow = ['mcp__wayroost__send_message', 'Read', 'mcp__wayroost__send_message'];
  }
  writeFileSync(f.paseo, JSON.stringify(current));
  const before = f.paths.map(path => readFileSync(path));
  expect(f.run('verify').status).toBe(1);
  expect(f.run('reverse').status).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it.each(['object', 'array'].flatMap(shape => ['delete', 'reorder', 'replace'].map(edit => ({ shape, edit }))))(
  'refuses $edit of enclosing cron jobs in $shape documents before publication', ({ shape, edit }) => {
    const f = cronFixture(shape);
    expect(f.run('forward').status).toBe(0);
    const current = JSON.parse(readFileSync(f.cron, 'utf8'));
    const jobs = shape === 'array' ? current : current.jobs;
    if (edit === 'delete') jobs.shift();
    else if (edit === 'reorder') jobs.reverse();
    else jobs[0] = { ...jobs[0], id: 'fake-replacement-job' };
    writeFileSync(f.cron, JSON.stringify(current));
    const paths = [...f.paths, f.cron, f.receipt];
    const before = paths.map(path => readFileSync(path));
    for (const verb of ['verify', 'reverse', 'forward']) {
      const result = f.run(verb);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('List reference provenance changed at /');
      expect(result.stderr).not.toContain('fake-job');
      expect(paths.map(path => readFileSync(path))).toEqual(before);
    }
  });

it.each(['object', 'array'])('checks enclosing cron provenance in reverse state for %s documents', shape => {
  const f = cronFixture(shape);
  expect(f.run('forward').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  const current = JSON.parse(readFileSync(f.cron, 'utf8'));
  const jobs = shape === 'array' ? current : current.jobs;
  jobs[0].id = 'fake-replacement-job';
  writeFileSync(f.cron, JSON.stringify(current));
  const paths = [...f.paths, f.cron, f.receipt];
  const before = paths.map(path => readFileSync(path));
  for (const [verb, extra] of [['verify', ['--expect', 'reverse']], ['reverse', []], ['forward', []]] as const) {
    const result = f.run(verb, [...extra]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('List reference provenance changed at /');
    expect(paths.map(path => readFileSync(path))).toEqual(before);
  }
});

it.each(['object', 'array'])('refuses cron receipts without enclosing list provenance in %s documents', shape => {
  const f = cronFixture(shape);
  expect(f.run('forward').status).toBe(0);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  const file = receipt.files.find((item: { path: string }) => item.path === f.cron);
  file.referenceLists = file.referenceLists.filter((item: { path: unknown[] }) =>
    item.path[item.path.length - 1] === 'enabled_toolsets');
  writeFileSync(f.receipt, JSON.stringify(receipt));
  writeFileSync(f.cron, JSON.stringify(JSON.parse(readFileSync(f.cron, 'utf8')), null, 2));
  const paths = [...f.paths, f.cron, f.receipt];
  const before = paths.map(path => readFileSync(path));
  for (const verb of ['verify', 'reverse', 'forward']) {
    const result = f.run(verb);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Receipt lacks list reference provenance at /');
    expect(paths.map(path => readFileSync(path))).toEqual(before);
  }
});

it.each(['object', 'array'])('refuses appended canonical cron jobs in %s documents before undo', shape => {
  const f = cronFixture(shape);
  expect(f.run('forward').status).toBe(0);
  const current = JSON.parse(readFileSync(f.cron, 'utf8'));
  const jobs = shape === 'array' ? current : current.jobs;
  jobs.push({ id: 'fake-job-c', enabled_toolsets: ['wayroost'], prompt: 'example c' });
  writeFileSync(f.cron, JSON.stringify(current, null, 2));
  expect(f.run('verify').status).toBe(0);
  const before = [...f.paths, f.cron, f.receipt].map(path => readFileSync(path));
  const result = f.run('reverse');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(`${shape === 'array' ? '' : '/jobs'}/2/enabled_toolsets/0`);
  expect([...f.paths, f.cron, f.receipt].map(path => readFileSync(path))).toEqual(before);
});

it.each(['forward', 'reverse'])('refuses unrecorded permission migrations when reusing a receipt in %s state', state => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  if (state === 'reverse') expect(f.run('reverse').status).toBe(0);
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { deny: ['mcp__signalbox__send_message'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  const before = f.paths.map(path => readFileSync(path));
  const receipt = readFileSync(f.receipt);
  const result = f.run('forward');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/permissions/deny/0');
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  expect(readFileSync(f.receipt)).toEqual(receipt);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('plan').status).toBe(0);
  const freshReceipt = join(f.dir, 'fresh-receipt.json');
  expect(f.run('forward', ['--receipt', freshReceipt]).status).toBe(0);
  expect(JSON.parse(readFileSync(f.paseo, 'utf8')).permissions.deny).toEqual(['mcp__wayroost__send_message']);
  expect(f.run('reverse', ['--receipt', freshReceipt]).status).toBe(0);
  expect(JSON.parse(readFileSync(f.paseo, 'utf8')).permissions.deny).toEqual(['mcp__signalbox__send_message']);
});

it('refuses a new legacy rule appended to a recorded list without widening its receipt', () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { deny: ['mcp__signalbox__read_chat'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  const current = JSON.parse(readFileSync(f.paseo, 'utf8'));
  current.permissions.deny.push('mcp__signalbox__send_message');
  writeFileSync(f.paseo, JSON.stringify(current));
  const before = f.paths.map(path => readFileSync(path));
  const result = f.run('forward');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/permissions/deny/1');
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it('refuses new allowlist and permission-key migrations when reusing a receipt', () => {
  const f = fixture();
  const opencode = join(f.dir, 'opencode.json');
  writeFileSync(opencode, '{"mcp":{"signalbox":{"command":["node","/home/me/bridge.mjs"]}}}');
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'opencode', path: opencode, map: '/mcp' });
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('forward').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  const hermes = readFileSync(f.hermes);
  writeFileSync(f.hermes, hermes.toString() + 'platform_toolsets: {cron: [signalbox]}\n');
  let before = [...f.paths, opencode].map(path => readFileSync(path));
  let result = f.run('forward');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/platform_toolsets/cron/0');
  expect([...f.paths, opencode].map(path => readFileSync(path))).toEqual(before);
  writeFileSync(f.hermes, hermes);
  const data = JSON.parse(readFileSync(opencode, 'utf8'));
  data.permission = { mcp__signalbox__send_message: 'deny' };
  writeFileSync(opencode, JSON.stringify(data));
  before = [...f.paths, opencode].map(path => readFileSync(path));
  result = f.run('forward');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('/permission/mcp__signalbox__send_message');
  expect([...f.paths, opencode].map(path => readFileSync(path))).toEqual(before);
});

it.each([
  '{command: node,}',
  '{command: node, # keep separator comment,\n    }',
  '{command: node # keep comment comma,\n    }',
  '{command: "node,",}',
  '{command: node, env: {DEMO: fixture,}}',
  '{command: node, env: {DEMO: fixture, # keep environment comment,\n    }}',
  '{command: node, env: {DEMO: fixture # keep comment comma,\n    }}',
  '{command: node, env: { # keep empty environment comment,\n    }}',
])('stamps and reverses flow registrations with preserved separators and comments: %s', entry => {
  const f = fixture();
  const original = `mcp_servers:\n  signalbox: ${entry}\nplugins: {enabled: [signalbox-identity]}\nmodel: demo\n`;
  writeFileSync(f.hermes, original);
  for (const verb of ['plan', 'forward', 'verify']) {
    const result = f.run(verb);
    expect(result.status, result.stderr).toBe(0);
  }
  const current = readFileSync(f.hermes, 'utf8');
  const before = parse(original).mcp_servers.signalbox;
  expect(parse(current).mcp_servers.wayroost).toEqual({ ...before,
    env: { ...before.env, WAYROOST_BRIDGE_NAME: 'wayroost' } });
  for (const comment of original.match(/#[^\r\n]*/g) ?? []) expect(current).toContain(comment);
  expect(f.run('reverse').status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(original);
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + '# later owner comment\n');
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8'))).toEqual(parse(original));
  expect(readFileSync(f.hermes, 'utf8')).toContain('# later owner comment');
  for (const comment of original.match(/#[^\r\n]*/g) ?? []) expect(readFileSync(f.hermes, 'utf8')).toContain(comment);
});

it.each(['registration', 'environment'])('keeps comments containing commas during semantic %s rollback', location => {
  const f = fixture();
  const entry = location === 'registration'
    ? '{command: node, # keep owner comment, exactly\n    }'
    : '{command: node, env: {DEMO: fixture, # keep owner comment, exactly\n    }}';
  const original = `mcp_servers:\n  signalbox: ${entry}\nplugins: {enabled: [signalbox-identity]}\n`;
  writeFileSync(f.hermes, original);
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'ownerCache: example\n');
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  const current = readFileSync(f.hermes, 'utf8');
  expect(current).toContain('# keep owner comment, exactly\n');
  expect(parse(current)).toEqual({ ...parse(original), ownerCache: 'example' });
});

it.each(['yaml', 'json'])('migrates and audits whole-document flow %s while exactly reversing it', format => {
  const f = fixture();
  const text = format === 'yaml'
    ? '{mcp_servers: {signalbox: {command: node}}, plugins: {enabled: [signalbox-identity]}}\n'
    : '{"mcp_servers":{"signalbox":{"command":"node"}},"plugins":{"enabled":["signalbox-identity"]}}\n';
  writeFileSync(f.hermes, text);
  const mirror = f.mirror;
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.inventory = spec.targets;
  spec.pluginMirror = mirror;
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('plan').status).toBe(0);
  expect(f.run('forward').status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8')).mcp_servers.wayroost).toEqual({
    command: 'node', env: { WAYROOST_BRIDGE_NAME: 'wayroost' },
  });
  expect(f.run('verify').status).toBe(0);
  expect(f.run('cutoff').status).toBe(0);
  expect(f.run('audit').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(text);
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + '# keep later comment\n');
  expect(f.run('reverse').status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(text + '# keep later comment\n');
});

it.each(['signalbox', 'wayroost'])('preserves the inactive identity alias when starting with %s enabled', name => {
  const f = fixture();
  const other = name === 'signalbox' ? 'wayroost' : 'signalbox';
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8')
    .replace('enabled: [other, signalbox-identity]', `enabled: [other, ${name}-identity]`)
    .replace('disabled: [unused]', `disabled: [unused, ${other}-identity]`));
  const original = readFileSync(f.hermes);
  expect(f.run('plan').status).toBe(0);
  expect(f.run('forward').status).toBe(0);
  expect(JSON.parse(readFileSync(f.receipt, 'utf8')).files[0].pluginNamesBefore).toEqual([
    { path: ['plugins', 'enabled', 1], name: `${name}-identity` },
    { path: ['plugins', 'disabled', 1], name: `${other}-identity` },
  ]);
  expect(parse(readFileSync(f.hermes, 'utf8')).plugins).toEqual({
    enabled: ['other', 'wayroost-identity'], disabled: ['unused', 'signalbox-identity'],
  });
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes)).toEqual(original);
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + '# owner comment\nownerCache: example\n');
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(original.toString() + '# owner comment\nownerCache: example\n');
});

it('preserves a uniquely disabled identity plugin and refuses unexpected enablement changes', () => {
  const f = fixture();
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8')
    .replace('enabled: [other, signalbox-identity]', 'enabled: [other]')
    .replace('disabled: [unused]', 'disabled: [unused, signalbox-identity]'));
  const original = readFileSync(f.hermes);
  expect(f.run('forward').status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8')).plugins).toEqual({
    enabled: ['other'], disabled: ['unused', 'wayroost-identity'],
  });
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(readFileSync(f.hermes)).toEqual(original);
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8')
    .replace('enabled: [other]', 'enabled: [other, wayroost-identity]')
    .replace('disabled: [unused, wayroost-identity]', 'disabled: [unused]'));
  const before = f.paths.map(path => readFileSync(path));
  expect(f.run('verify').status).toBe(1);
  expect(f.run('reverse').status).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it('accepts an inactive alias added by setup after forward and preserves its disabled state on undo', () => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8').replace('disabled: [unused]', 'disabled: [unused, signalbox-identity]'));
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8')).plugins).toEqual({
    enabled: ['other', 'signalbox-identity'], disabled: ['unused', 'wayroost-identity'],
  });
});

it('records only hashes and edit spans, without unrelated or bridge configuration values', () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.pi, 'utf8'));
  data.fakeCredential = 'obviously-fake-unrelated-secret';
  data.mcpServers.signalbox.env.FAKE_CREDENTIAL = 'obviously-fake-bridge-secret';
  writeFileSync(f.pi, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  const receipt = readFileSync(f.receipt, 'utf8');
  expect(receipt).not.toContain('obviously-fake-unrelated-secret');
  expect(receipt).not.toContain('obviously-fake-bridge-secret');
  expect(receipt).not.toContain(Buffer.from(readFileSync(f.pi)).toString('base64'));
  const recorded = JSON.parse(receipt);
  expect(recorded.files.every((file: { edits: unknown[] }) => file.edits.length > 0)).toBe(true);
  expect(f.run('reverse').status).toBe(0);
});

it('requires the full inventory and a verified false plugin mirror for cutoff completion', () => {
  const f = fixture();
  const remaining = join(f.dir, 'opencode.json');
  const mirror = f.mirror;
  writeFileSync(remaining, JSON.stringify({ mcp: { signalbox: { command: ['node', '/demo/bridge.mjs'] } } }));
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.inventory = [...spec.targets, { kind: 'opencode', path: remaining, map: '/mcp' }];
  spec.pluginMirror = mirror;
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('forward').status).toBe(0);
  expect(f.run('audit').status).toBe(1);
  expect(f.run('cutoff').status).toBe(1);
  expect(existsSync(mirror)).toBe(false);
  writeFileSync(remaining, JSON.stringify({ mcp: { wayroost: { command: ['node', '/demo/bridge.mjs'], environment: { WAYROOST_BRIDGE_NAME: 'wayroost' } } } }));
  expect(f.run('audit').status).toBe(1);
  expect(f.run('cutoff').status).toBe(0);
  expect(JSON.parse(readFileSync(mirror, 'utf8'))).toEqual({ bridge: { legacyNames: false } });
  expect(f.run('audit').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8').replace('disabled: [unused]', 'disabled: [unused, signalbox-identity]'));
  expect(f.run('audit').status).toBe(0);
  writeFileSync(mirror, '{"bridge":{"legacyNames":true}}');
  expect(f.run('audit').status).toBe(1);
  delete spec.inventory;
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('cutoff').status).toBe(1);
});

it.each(['json', 'yaml-flow', 'yaml-block'])('reverses %s registrations with newly created environments after unrelated writes', format => {
  const f = fixture();
  const file = format === 'json' ? f.pi : f.hermes;
  if (format === 'json') {
    writeFileSync(file, '{\r\n  "mcpServers": { "signalbox": {"command":"node", "args": ["/home/me/bridge.mjs"]} }, "label":"café"\r\n}\r\n');
  } else {
    writeFileSync(file, format === 'yaml-flow'
      ? 'mcp_servers: {signalbox: {command: node, args: [/home/me/bridge.mjs]}}\nplugins: {enabled: [signalbox-identity]}\nlabel: café\n'
      : 'mcp_servers:\n  signalbox:\n    command: node\n    args: [/home/me/bridge.mjs]\nplugins:\n  enabled: [signalbox-identity]\nlabel: café\n');
  }
  const original = readFileSync(file);
  expect(f.run('forward').status).toBe(0);
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(readFileSync(file)).toEqual(original);
  expect(f.run('forward').status).toBe(0);
  if (format === 'json') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.ownerCache = 'example';
    writeFileSync(file, JSON.stringify(data, null, 2));
  } else {
    writeFileSync(file, readFileSync(file, 'utf8') + '# keep later comment\nownerCache: example\n');
  }
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  const current = format === 'json' ? JSON.parse(readFileSync(file, 'utf8')) : parse(readFileSync(file, 'utf8'));
  const before = format === 'json' ? JSON.parse(original.toString()) : parse(original.toString());
  expect(current).toEqual({ ...before, ownerCache: 'example' });
  if (format !== 'json') expect(readFileSync(file, 'utf8')).toContain('# keep later comment');
});

it('preserves an already canonical registration when reversing a receipt after owner changes', () => {
  const f = fixture();
  for (const path of [f.hermes, f.pi, f.paseo]) {
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('signalbox', 'wayroost'));
  }
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + '# later owner comment\n');
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(parse(readFileSync(f.hermes, 'utf8')).mcp_servers.wayroost).toBeDefined();
});

it('reverses permissions when the canonical registration is unchanged in both receipt states', () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.mcpServers.wayroost = data.mcpServers.signalbox;
  data.mcpServers.wayroost.env.WAYROOST_BRIDGE_NAME = 'wayroost';
  delete data.mcpServers.signalbox;
  data.permissions = { deny: ['mcp__signalbox__send_message', 'mcp__wayroost__send_message'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  expect(f.run('forward').status).toBe(0);
  const current = JSON.parse(readFileSync(f.paseo, 'utf8'));
  current.ownerCache = 'example';
  writeFileSync(f.paseo, JSON.stringify(current, null, 2));
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(JSON.parse(readFileSync(f.paseo, 'utf8'))).toEqual({ ...data, ownerCache: 'example' });
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('forward').status).toBe(0);
  expect(f.run('verify').status).toBe(0);
});

it('refuses an unsupported reference in another server and a permission-key collision', () => {
  const f = fixture();
  const settings = join(f.dir, 'settings.json');
  writeFileSync(settings, '{"permissions":{"allow":["mcp__signalbox__read_chat"]},"unexpected":{"tool":"signalbox_send_message"}}');
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'claude', path: settings });
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('plan').stderr).toContain('/unexpected/tool');
  const code = join(f.dir, 'opencode.json');
  writeFileSync(code, '{"mcp":{"signalbox":{"command":["node","/home/me/bridge.mjs"]}},"tools":{"mcp__signalbox__*":false,"mcp__wayroost__*":true}}');
  spec.targets.pop();
  spec.targets.push({ kind: 'opencode', path: code, map: '/mcp' });
  writeFileSync(f.manifest, JSON.stringify(spec));
  const before = f.paths.map(path => readFileSync(path));
  expect(f.run('forward').status).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it('recovers a partial publication from the journal, then restores the original bytes', () => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  writeFileSync(f.pi, f.before[1]!);
  expect(f.run('verify').status).toBe(1);
  expect(f.run('forward').status).toBe(0);
  expect(f.run('verify').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.paths.map(path => readFileSync(path))).toEqual(f.before);
});

it.each(['registration', 'plugin', 'duplicate', 'alias'])('refuses %s collisions or ambiguous YAML before writing', problem => {
  const f = fixture();
  const additions = {
    registration: '\n  wayroost: {command: demo}\n',
    plugin: '', duplicate: '\n  signalbox: {command: other}\n', alias: '\n  aliased: &shared {command: demo}\n  another: *shared\n',
  };
  let text = readFileSync(f.hermes, 'utf8').replace('plugins:', `${additions[problem as keyof typeof additions]}plugins:`);
  if (problem === 'plugin') text = text.replace('enabled: [other, signalbox-identity]', 'enabled: [other, signalbox-identity, wayroost-identity]');
  writeFileSync(f.hermes, text);
  const before = f.paths.map(path => readFileSync(path));
  expect(f.run('forward').status).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it.each(['enabled: [other, signalbox-identity, signalbox-identity]', 'enabled: [other, signalbox-identity]\n  disabled: [signalbox-identity]'])(
  'refuses duplicate or contradictory identity plugin state %s', state => {
    const f = fixture();
    writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8').replace(
      'enabled: [other, signalbox-identity] # keep plugin comment\n  disabled: [unused]', state));
    const before = f.paths.map(path => readFileSync(path));
    expect(f.run('forward').status).toBe(1);
    expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  });

it('documents plugin-list edits and service-manager reloads without launcher commands', () => {
  for (const path of ['docs/bridge.md', 'docs/setup.md', 'deploy/setup-bridge.sh']) {
    const text = readFileSync(resolve(path), 'utf8');
    expect(text).not.toMatch(/hermes\s+(?:plugins\s+(?:enable|remove)|gateway\s+restart)/);
    expect(text).toMatch(/service manager/);
  }
  expect(readFileSync(resolve('docs/bridge.md'), 'utf8')).toContain('plugins.enabled');
});

it('stamps manual canonical registrations in Copilot output and documentation', () => {
  const script = readFileSync(resolve('deploy/setup-bridge.sh'), 'utf8');
  const copilot = script.slice(script.indexOf('if user_has "$UHOME/.copilot"'), script.indexOf('\necho\necho "==> Summary'));
  const result = spawnSync('bash', ['-c', `user_has() { return 0; }\nfind_tool() { return 1; }\nWRAPPER=/home/me/bridge.mjs\nMANUAL=()\n${copilot}`],
    { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('env WAYROOST_BRIDGE_NAME=wayroost node "/home/me/bridge.mjs"');
  const doc = readFileSync(resolve('docs/bridge.md'), 'utf8');
  expect(doc).toContain('claude mcp add --scope user wayroost -e WAYROOST_BRIDGE_NAME=wayroost -- node');
  expect(doc).toMatch(/server named `wayroost`[\s\S]*?`env WAYROOST_BRIDGE_NAME=wayroost node/);
});

it('refuses drift before any reverse writes and prints no configuration values', () => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  const secret = 'invented-private-config-value';
  writeFileSync(f.paseo, JSON.stringify({ mcpServers: { wayroost: { command: secret } } }));
  const before = f.paths.map(path => readFileSync(path));
  const result = f.run('reverse');
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
});

it('refuses symlinks, changed modes, and manifests selecting memories', () => {
  const f = fixture();
  expect(f.run('forward').status).toBe(0);
  chmodSync(f.pi, 0o600);
  expect(f.run('reverse').status).toBe(1);
  chmodSync(f.pi, 0o640);
  rmSync(f.pi);
  symlinkSync(f.paseo, f.pi);
  expect(f.run('verify').status).toBe(1);
  writeFileSync(f.manifest, JSON.stringify({ targets: [{ kind: 'paseo', path: f.paths[3], map: '/mcpServers' }] }));
  expect(f.run('plan').status).toBe(1);
});

it('refuses a manifest selecting itself instead of making its receipt impossible to reverse', () => {
  const f = fixture();
  writeFileSync(f.hermes, JSON.stringify({ targets: [{ kind: 'paseo', path: f.hermes, map: '/mcpServers' }],
    mcpServers: { signalbox: { command: 'invented' } } }));
  const result = spawnSync('python3', ['-I', '-B', resolve('deploy/bridge-names.py'), 'plan', '--manifest', f.hermes],
    { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('manifest cannot also');
});

it.each(['toolset', 'cron', 'deny', 'opencode'])('refuses unrecorded canonical %s references during reverse and reverse verification', kind => {
  const f = fixture();
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  let path = f.hermes;
  let pointer = '/platform_toolsets/telegram/1';
  if (kind === 'cron') {
    mkdirSync(join(f.dir, 'cron'));
    path = join(f.dir, 'cron', 'jobs.json');
    writeFileSync(path, '{"jobs":[]}');
    spec.targets.push({ kind: 'hermes', path });
    pointer = '/jobs/0/enabled_toolsets/0';
  } else if (kind === 'deny') {
    path = join(f.dir, 'settings.json');
    writeFileSync(path, '{}');
    spec.targets.push({ kind: 'claude', path });
    pointer = '/permissions/deny/0';
  } else if (kind === 'opencode') {
    path = join(f.dir, 'opencode.json');
    writeFileSync(path, '{"mcp":{"signalbox":{"command":["node","/demo/bridge.mjs"]}}}');
    spec.targets.push({ kind: 'opencode', path, map: '/mcp' });
    pointer = '/permission/mcp__wayroost__start_chat';
  }
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('forward').status).toBe(0);
  const forward = readFileSync(path, 'utf8');
  const addReference = () => {
    if (kind === 'toolset') {
      writeFileSync(path, readFileSync(path, 'utf8') + 'platform_toolsets: {telegram: [web, wayroost]}\n');
    } else {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (kind === 'cron') data.jobs.push({ id: 'fake-job', enabled_toolsets: ['wayroost'] });
      else if (kind === 'deny') data.permissions = { deny: ['mcp__wayroost__start_chat'] };
      else data.permission = { mcp__wayroost__start_chat: 'deny' };
      writeFileSync(path, JSON.stringify(data));
    }
  };
  addReference();
  const before = [...f.paths, path, f.receipt].map(file => readFileSync(file));
  let result = f.run('reverse');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(pointer);
  expect([...f.paths, path, f.receipt].map(file => readFileSync(file))).toEqual(before);
  writeFileSync(path, forward);
  expect(f.run('reverse').status).toBe(0);
  addReference();
  for (const [verb, extra] of [['verify', ['--expect', 'reverse']], ['reverse', []]] as const) {
    result = f.run(verb, [...extra]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(pointer);
  }
});

it.each(['permission', 'tools'])('refuses a migrated OpenCode %s alias restored after reverse', field => {
  const f = fixture();
  const path = join(f.dir, 'opencode.json');
  const value = field === 'permission' ? 'deny' : false;
  writeFileSync(path, JSON.stringify({
    mcp: { signalbox: { command: ['node', '/demo/bridge.mjs'] } },
    [field]: { mcp__signalbox__send_message: value },
  }));
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'opencode', path, map: '/mcp' });
  writeFileSync(f.manifest, JSON.stringify(spec));
  expect(f.run('forward').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data[field].mcp__wayroost__send_message = value;
  writeFileSync(path, JSON.stringify(data));
  const paths = [...f.paths, path, f.receipt];
  const before = paths.map(file => readFileSync(file));
  const verification = f.run('verify', ['--expect', 'reverse']);
  expect(verification.status, verification.stderr).toBe(1);
  expect(verification.stderr).toContain(`/${field}/mcp__wayroost__send_message`);
  expect(paths.map(file => readFileSync(file))).toEqual(before);
  const reversal = f.run('reverse');
  expect(reversal.status, reversal.stderr).toBe(1);
  expect(reversal.stderr).toContain(`Permission reference collision at /${field}`);
  expect(paths.map(file => readFileSync(file))).toEqual(before);
});

it.each(['permission', 'tools'])('preserves pre-existing canonical OpenCode %s keys during reverse verification', field => {
  const f = fixture();
  const path = join(f.dir, 'opencode.json');
  const rules = { mcp__signalbox__send_message: field === 'permission' ? 'deny' : false,
    mcp__wayroost__read_chat: field === 'permission' ? 'allow' : true };
  writeFileSync(path, JSON.stringify({
    mcp: { signalbox: { command: ['node', '/demo/bridge.mjs'] } }, [field]: rules,
  }));
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.targets.push({ kind: 'opencode', path, map: '/mcp' });
  writeFileSync(f.manifest, JSON.stringify(spec));
  const original = readFileSync(path);
  expect(f.run('forward').status).toBe(0);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(path)).toEqual(original);
  expect(f.run('forward').status).toBe(0);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  data.ownerCache = 'example';
  writeFileSync(path, JSON.stringify(data, null, 2));
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  const reversed = JSON.parse(readFileSync(path, 'utf8'));
  expect(reversed[field]).toEqual(rules);
  expect(reversed.ownerCache).toBe('example');
  const before = [...f.paths, path, f.receipt].map(file => readFileSync(file));
  expect(f.run('reverse').status).toBe(0);
  expect([...f.paths, path, f.receipt].map(file => readFileSync(file))).toEqual(before);
});

it('records pre-existing canonical reference pointers and enclosing hashes and preserves them', () => {
  const f = cronFixture('object');
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'platform_toolsets: {telegram: [web, wayroost]}\n');
  const data = JSON.parse(readFileSync(f.paseo, 'utf8'));
  data.permissions = { deny: ['mcp__wayroost__start_chat'] };
  writeFileSync(f.paseo, JSON.stringify(data));
  const originals = [...f.paths, f.cron].map(path => readFileSync(path));
  expect(f.run('forward').status).toBe(0);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  expect(receipt.files[0].canonicalReferences).toEqual([
    { path: ['platform_toolsets', 'telegram', 1], key: false, value: 'wayroost' },
  ]);
  expect(receipt.files[0].referenceLists[0]).toMatchObject({ path: ['platform_toolsets', 'telegram'], length: 2 });
  expect(receipt.files[0].referenceLists[0].beforeHash).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'ownerCache: example\n');
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(originals[0]!.toString() + 'ownerCache: example\n');
  expect([...f.paths.slice(1), f.cron].map(path => readFileSync(path))).toEqual(originals.slice(1));
});

it.each(['missing', 'wrong-name', 'symlink'])('refuses migration and verification with a %s canonical plugin', problem => {
  const f = fixture();
  const installed = join(f.pluginDir, 'plugin.yaml');
  const breakPlugin = () => {
    rmSync(installed);
    if (problem === 'wrong-name') writeFileSync(installed, 'name: signalbox-identity\n');
    else if (problem === 'symlink') symlinkSync(f.hermes, installed);
  };
  breakPlugin();
  const before = f.paths.map(path => readFileSync(path));
  let result = f.run('forward');
  expect(result.status, result.stderr).toBe(1);
  expect(f.paths.map(path => readFileSync(path))).toEqual(before);
  expect(existsSync(f.receipt)).toBe(false);
  rmSync(installed, { force: true });
  writeFileSync(installed, 'name: wayroost-identity\n');
  expect(f.run('forward').status).toBe(0);
  breakPlugin();
  result = f.run('verify');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('Canonical identity plugin');
});

it.each(['absent', 'empty', 'disabled'])('migrates and audits Hermes without an enabled identity plugin (%s)', state => {
  const f = fixture();
  const original = readFileSync(f.hermes, 'utf8').replace(
    'plugins:\n  enabled: [other, signalbox-identity] # keep plugin comment\n  disabled: [unused]\n',
    state === 'absent' ? '' : state === 'empty' ? 'plugins: {enabled: [other], disabled: [unused]}\n'
      : 'plugins: {enabled: [other], disabled: [unused, signalbox-identity]}\n');
  writeFileSync(f.hermes, original);
  const spec = JSON.parse(readFileSync(f.manifest, 'utf8'));
  spec.inventory = spec.targets;
  writeFileSync(f.manifest, JSON.stringify(spec));
  rmSync(f.pluginDir, { recursive: true });
  expect(f.run('plan').status).toBe(0);
  expect(f.run('forward').status).toBe(0);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  expect(receipt.files[0].identityPlugin).toBe('none');
  expect(f.run('verify').status).toBe(0);
  expect(f.run('cutoff').status).toBe(0);
  const audit = f.run('audit');
  expect(audit.status, audit.stderr).toBe(0);
  expect(JSON.parse(audit.stdout).unverifiedHermes).toEqual(['/mcp_servers/wayroost']);
  expect(f.run('reverse').status).toBe(0);
  expect(f.run('verify', ['--expect', 'reverse']).status).toBe(0);
  expect(readFileSync(f.hermes, 'utf8')).toBe(original);
});

it('documents installing the canonical plugin before migrating registrations in both upgrade guides', () => {
  const bridge = readFileSync(resolve('docs/bridge.md'), 'utf8');
  const upgrade = bridge.slice(bridge.indexOf('## Upgrading'), bridge.indexOf('## Turning it off'));
  expect(upgrade.indexOf('2. Run `setup-bridge.sh`')).toBeGreaterThan(0);
  expect(upgrade.indexOf('3. With writers held, migrate')).toBeGreaterThan(upgrade.indexOf('2. Run `setup-bridge.sh`'));
  const names = readFileSync(resolve('docs/bridge-names.md'), 'utf8');
  expect(names.indexOf('2. With writers held')).toBeGreaterThan(names.indexOf('1. Install the updated wrapper and canonical identity plugin'));
});

it('refuses an exact-byte undo when the receipt lacks a pre-existing canonical reference', () => {
  const f = fixture();
  writeFileSync(f.hermes, readFileSync(f.hermes, 'utf8') + 'platform_toolsets: {telegram: [web, wayroost]}\n');
  expect(f.run('forward').status).toBe(0);
  const receipt = JSON.parse(readFileSync(f.receipt, 'utf8'));
  delete receipt.files[0].canonicalReferences;
  writeFileSync(f.receipt, JSON.stringify(receipt));
  const before = [...f.paths, f.receipt].map(path => readFileSync(path));
  const result = f.run('reverse');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('/platform_toolsets/telegram/1');
  expect([...f.paths, f.receipt].map(path => readFileSync(path))).toEqual(before);
});
