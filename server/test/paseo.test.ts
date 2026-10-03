import { BackgroundGate } from '../src/background.js';
import type { AgentPermissionRequest } from '@getpaseo/protocol/agent-types';
import { AGENT_PROVIDER_DEFINITIONS } from '@getpaseo/protocol/provider-manifest';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, TimelineItem } from '../../shared/protocol.js';
import type { Attachment } from '../src/attachments.js';
import { EventHub } from '../src/hub.js';
import { MAX_MEDIA_BYTES } from '../src/media.js';
import { Lineage } from '../src/lineage.js';
import { APP_VERSION, PaseoAdapter } from '../src/paseo/adapter.js';
import { AgentTimelineMirror, type MirrorRow, type MirrorSink } from '../src/paseo/mirror.js';
import { deviceSignal, withDeviceSignal } from '../src/security/device-signal.js';
import {
  DISMISS_OPTION,
  HERMES_BUSY_MODEL,
  HERMES_PARENT_LABEL,
  KNOWN_MODES,
  PARENT_AGENT_LABEL,
  SUBAGENT_READ_ONLY,
  agentControls,
  agentLoaded,
  agentSummary,
  defaultMode,
  imageReadRoot,
  lastActivity,
  modeTier,
  permissionResponse,
  questionAnswer,
  requestApprovals,
  slashCommands,
  subagentRowId,
  thinkingLabel,
  timelineItem,
} from '../src/paseo/normalize.js';
import { UserFacingError } from '../src/sources.js';
import { buildApp } from '../src/app.js';
import { createAccessVerifier } from '../src/security/access.js';
import { FakeHermes, makeConfig, makeKeys, makeToken, postHeaders } from './helpers.js';

const quietLog = { info() {}, warn() {}, error() {} };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\n1 0 obj\n');
const image: Attachment = { name: 'shot.png', mimeType: 'image/png', kind: 'image', bytes: PNG };
const notes: Attachment = { name: 'notes.md', mimeType: 'text/markdown', kind: 'text', bytes: Buffer.from('# hi') };
const spec: Attachment = { name: 'spec.pdf', mimeType: 'application/pdf', kind: 'pdf', bytes: PDF };

const CLAUDE_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].map((id) => ({ id, label: id }));
const CLAUDE_CATALOG = {
  models: [
    {
      provider: 'claude',
      id: 'claude-sonnet',
      label: 'Sonnet',
      isDefault: true,
      contextWindowMaxTokens: 200_000,
      thinkingOptions: [{ id: 'low', label: 'low' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'xhigh' }],
      defaultThinkingOptionId: 'low',
    },
    { provider: 'claude', id: 'claude-opus', label: 'Opus', aliases: ['opus'], thinkingOptions: [{ id: 'on', label: 'On' }] },
    { provider: 'claude', id: 'claude-internal', label: 'Internal', isSelectable: false },
  ],
  modes: CLAUDE_MODES,
};
const HERMES_MODES = [
  { id: 'default', label: 'Ask first' },
  { id: 'accept_edits', label: 'Accept edits' },
  { id: 'dont_ask', label: "Don't ask" },
];
const HERMES_CATALOG = { models: [{ provider: 'hermes', id: 'gpt', label: 'GPT' }, { provider: 'hermes', id: 'kimi', label: 'Kimi' }], modes: HERMES_MODES };

/** A running Claude Code agent in default mode, on Sonnet. */
const claudeAgent = (overrides: object = {}) => ({
  id: 'claude1',
  provider: 'claude',
  cwd: '/home/me/code/app',
  title: 'Claude agent',
  status: 'idle',
  updatedAt: '2026-09-27T00:00:00Z',
  pendingPermissions: [],
  labels: {},
  model: null,
  runtimeInfo: { provider: 'claude', sessionId: 's1', model: 'claude-sonnet' },
  thinkingOptionId: null,
  effectiveThinkingOptionId: null,
  capabilities: { supportsStreaming: true },
  availableModes: CLAUDE_MODES,
  currentModeId: 'default',
  ...overrides,
});

const shellRequest: AgentPermissionRequest = {
  id: 'perm-1',
  provider: 'hermes',
  name: 'terminal',
  kind: 'tool',
  title: 'Run command',
  detail: { type: 'shell', command: 'rm -rf build' },
  actions: [
    { id: 'allow_once', label: 'Allow once', behavior: 'allow' },
    { id: 'allow_session', label: 'Allow for session', behavior: 'allow' },
    { id: 'allow_always', label: 'Always allow', behavior: 'allow' },
    { id: 'deny', label: 'Deny', behavior: 'deny' },
  ],
} as AgentPermissionRequest;

const questionRequest = {
  id: 'perm-q',
  provider: 'claude',
  name: 'AskUserQuestion',
  kind: 'question',
  input: {
    questions: [
      { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
      { question: 'Which extras?', header: 'Extras', options: [{ label: 'Auth' }, { label: 'Billing' }], multiSelect: true },
    ],
  },
} as unknown as AgentPermissionRequest;

describe('paseo normalization', () => {
  it('classifies every known Paseo mode by how much it keeps you in the loop', () => {
    const tiers = (provider: string, ids: string[]) => ids.map((id) => modeTier(provider, { id, label: id }));
    expect(tiers('claude', ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'])).toEqual([
      'asks', 'asks', 'auto', 'auto', 'blocked',
    ]);
    expect(tiers('codex', ['auto', 'auto-review', 'full-access'])).toEqual(['asks', 'auto', 'blocked']);
    expect(tiers('copilot', ['agent', 'plan', 'allow-all'])).toEqual(['asks', 'asks', 'blocked']);
    // In 0.9.2 Copilot's ACP modes are named by the protocol's URLs.
    const acp = 'https://agentclientprotocol.com/protocol/session-modes#';
    expect(tiers('copilot', [`${acp}agent`, `${acp}plan`])).toEqual(['asks', 'asks']);
    expect(tiers('omp', ['ask', 'write', 'full'])).toEqual(['asks', 'auto', 'blocked']);
    expect(tiers('opencode', ['plan', 'build'])).toEqual(['asks', 'auto']);
    expect(tiers('hermes', ['default', 'accept_edits', 'dont_ask'])).toEqual(['asks', 'auto', 'blocked']);
    // Unknown providers: blocked by name, asking only for conservative ids, otherwise "acts on its own".
    expect(tiers('newagent', ['yolo', 'Skip-Permissions', 'default', 'turbo'])).toEqual(['blocked', 'blocked', 'asks', 'auto']);
  });

  it("classifies every mode of the installed client's built-in providers explicitly", () => {
    const unclassified = AGENT_PROVIDER_DEFINITIONS.flatMap((provider) =>
      (provider.modes ?? []).filter((mode) => !KNOWN_MODES[provider.id]?.[mode.id]).map((mode) => `${provider.id}/${mode.id}`));
    expect(unclassified).toEqual([]);
  });

  it('starts in a mode that asks, preferring the provider default only if it asks', () => {
    const claude = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].map((id) => ({ id, label: id }));
    expect(defaultMode('claude', claude, 'auto')).toBe('default');
    expect(defaultMode('codex', [{ id: 'auto', label: 'a' }, { id: 'full-access', label: 'f' }], 'full-access')).toBe('auto');
    expect(defaultMode('opencode', [{ id: 'build', label: 'b' }, { id: 'plan', label: 'p' }], 'build')).toBe('plan');
    expect(defaultMode('hermes', [{ id: 'dont_ask', label: 'd' }], null)).toBeUndefined();
  });

  it('warns that approving a Claude plan switches it to auto-accepting edits', () => {
    const plan = {
      id: 'perm-plan',
      provider: 'claude',
      name: 'ExitPlanMode',
      kind: 'plan',
      actions: [
        { id: 'implement', label: 'Implement', behavior: 'allow', intent: 'implement' },
        { id: 'dismiss', label: 'Keep planning', behavior: 'deny', intent: 'dismiss' },
      ],
    } as unknown as AgentPermissionRequest;
    const [approval] = requestApprovals('a1', plan, 0).approvals;
    expect(approval!.options[0]!.label).toBe('Implement (then auto-accepts edits)');
  });

  it('never silently shortens a command you are asked to approve', () => {
    const long = { ...shellRequest, id: 'perm-long', detail: { type: 'shell', command: `npm test${'\n'.repeat(10)}${'x'.repeat(70_000)}` } } as AgentPermissionRequest;
    const [approval] = requestApprovals('a1', long, 0).approvals;
    expect(approval!.detailTruncated).toBe(true);
    const short = requestApprovals('a1', shellRequest, 0).approvals[0]!;
    expect(short.detailTruncated).toBeUndefined();
  });

  it('maps ACP permission actions and only accepts offered ones', () => {
    const { approvals } = requestApprovals('agent-1', shellRequest, 0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: 'perm-1', kind: 'permission', title: 'Run command', detail: 'rm -rf build', detailKind: 'command' });
    expect(approvals[0]!.options.map((o) => o.kind)).toEqual(['allow', 'allow_session', 'allow_always', 'deny']);
    expect(permissionResponse(shellRequest, 'allow_once')).toEqual({ behavior: 'allow', selectedActionId: 'allow_once' });
    expect(permissionResponse(shellRequest, 'deny')).toEqual({ behavior: 'deny', selectedActionId: 'deny' });
    expect(permissionResponse(shellRequest, 'allow')).toBeNull();
    expect(permissionResponse(shellRequest, 'yolo')).toBeNull();
  });

  it("says what a structured detail is, whatever the request's title claims", () => {
    const kindOf = (detail: unknown, extra: Record<string, unknown> = {}) =>
      requestApprovals('a1', { ...shellRequest, title: 'Read file', detail, ...extra } as AgentPermissionRequest, 0).approvals[0]!
        .detailKind;
    expect(kindOf({ type: 'shell', command: '/tmp/erase.sh' })).toBe('command');
    expect(kindOf({ type: 'read', filePath: '/home/me/a.ts' })).toBe('read');
    expect(kindOf({ type: 'edit', filePath: '/home/me/a.ts', unifiedDiff: '@@ -1 +1 @@' })).toBe('edit');
    expect(kindOf({ type: 'write', filePath: '/home/me/a.ts', content: 'x' })).toBe('write');
    expect(kindOf({ type: 'fetch', url: 'https://example.com' })).toBe('fetch');
    expect(kindOf({ type: 'search', query: 'TODO' })).toBe('other');
    // A detail Paseo doesn't structure says nothing about what it is.
    expect(kindOf(undefined, { description: 'cat notes.md' })).toBeUndefined();
    expect(kindOf({ type: 'shell' })).toBeUndefined();
  });

  it("keeps a file request's path exactly as Paseo gives it", () => {
    const detailOf = (detail: unknown) =>
      requestApprovals('a1', { ...shellRequest, detail } as AgentPermissionRequest, 0).approvals[0]!.detail;
    expect(detailOf({ type: 'read', filePath: '/home/another-user/.ssh/config' })).toBe('/home/another-user/.ssh/config');
    expect(detailOf({ type: 'edit', filePath: '/etc/sudoers', unifiedDiff: '@@ -1 +1 @@' })).toBe('/etc/sudoers\n\n@@ -1 +1 @@');
    expect(detailOf({ type: 'write', filePath: '/home/me/code/a.ts', content: 'x' })).toBe('/home/me/code/a.ts\n\nx');
  });

  it("sends a file request's whole path apart from its detail", () => {
    const of = (detail: unknown) =>
      requestApprovals('a1', { ...shellRequest, detail } as AgentPermissionRequest, 0).approvals[0]!;
    // A line break in the path: the detail can't say where the path ends, the field can.
    const path = '/home/me/code/billing/src\n/../../../../../etc/sudoers';
    expect(of({ type: 'edit', filePath: path, unifiedDiff: '@@ -1 +1 @@' }).filePath).toBe(path);
    expect(of({ type: 'write', filePath: path, content: 'x' }).filePath).toBe(path);
    expect(of({ type: 'read', filePath: path }).filePath).toBe(path);
    // Only file requests carry one, and only a path that's sent whole.
    expect(of({ type: 'edit', unifiedDiff: '@@ -1 +1 @@' }).filePath).toBeUndefined();
    expect(of({ type: 'shell', command: 'ls', filePath: '/etc/passwd' }).filePath).toBeUndefined();
    const long = `/home/me/code/billing/${'a/'.repeat(40_000)}../../etc/sudoers`;
    const cut = of({ type: 'read', filePath: long });
    expect(cut.filePath).toBeUndefined();
    expect(cut.detailTruncated).toBe(true);
  });

  it("shows what an unstructured request runs, never only its description", () => {
    const bash = {
      ...shellRequest,
      name: 'Bash',
      title: 'Bash',
      detail: undefined,
      description: 'https://example.com',
      input: { command: 'rm -rf /srv/production' },
    } as unknown as AgentPermissionRequest;
    const [approval] = requestApprovals('a1', bash, 0).approvals;
    expect(approval!.detail).toContain('rm -rf /srv/production');
    expect(approval!.detail).not.toBe('https://example.com');
    expect(approval!.detailKind).toBeUndefined();
    // A structured detail with nothing in it falls back to the input too, untyped.
    const empty = requestApprovals('a1', { ...bash, detail: { type: 'shell' } } as AgentPermissionRequest, 0).approvals[0]!;
    expect(empty.detail).toContain('rm -rf /srv/production');
    expect(empty.detailKind).toBeUndefined();
    // With no input, the description is all there is.
    const said = requestApprovals('a1', { ...bash, input: undefined } as AgentPermissionRequest, 0).approvals[0]!;
    expect(said.detail).toBe('https://example.com');
    expect(said.detailKind).toBeUndefined();
  });

  it('splits multi-question requests and builds answers the way Paseo does', () => {
    const { approvals, questions } = requestApprovals('agent-1', questionRequest, 0);
    expect(approvals.map((a) => a.id)).toEqual(['perm-q.q0', 'perm-q.q1']);
    expect(approvals[1]).toMatchObject({ multiSelect: true, progress: 'Question 2 of 2' });
    expect(approvals[0]!.options.at(-1)).toMatchObject({ id: DISMISS_OPTION, kind: 'deny' });
    expect(questionAnswer(questions![0]!, { optionId: '1' })).toBe('SQLite');
    expect(questionAnswer(questions![0]!, { optionIds: ['0', '1'] })).toBeNull();
    expect(questionAnswer(questions![0]!, { text: 'Mongo' })).toBeNull();
    expect(questionAnswer(questions![1]!, { optionIds: ['0', '1'] })).toBe('Auth, Billing');
    expect(questionAnswer(questions![1]!, { optionId: '9' })).toBeNull();
  });

  it('renders timeline items readably', () => {
    expect(
      timelineItem('k1', {
        type: 'tool_call',
        callId: 'c1',
        name: 'Bash',
        status: 'failed',
        error: 'boom',
        detail: { type: 'shell', command: 'npm test', output: 'fail', exitCode: 1 },
      } as never),
    ).toMatchObject({ kind: 'tool', summary: 'npm test', status: 'error', input: 'npm test' });
    expect(timelineItem('k2', { type: 'assistant_message', text: '[System Error] quota exceeded' })).toEqual({
      kind: 'notice',
      id: 'k2',
      level: 'error',
      text: 'quota exceeded',
    });
    expect(
      timelineItem('k3', { type: 'todo', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] }),
    ).toMatchObject({ kind: 'tool', summary: '1 of 2 done' });
  });

  it('shows the files sent with a message, even when it had no text', () => {
    const files = [{ name: 'shot.png', kind: 'image' as const }];
    const user = (id: string, text: string) => ({ kind: 'user', id, text, attachments: files });
    expect(timelineItem('k1', { type: 'user_message', text: 'look' }, files)).toEqual(user('k1', 'look'));
    expect(timelineItem('k2', { type: 'user_message', text: '' }, files)).toEqual(user('k2', ''));
    expect(timelineItem('k3', { type: 'user_message', text: ' ' })).toBeNull();
    expect(timelineItem('k4', { type: 'user_message', text: 'hi' }, [])).toEqual({ kind: 'user', id: 'k4', text: 'hi' });
  });

  it("maps the agent's commands and skills for the \"/\" menu", () => {
    expect(
      slashCommands([
        { name: '/review', description: 'Review changes', argumentHint: '[focus]', kind: 'command' },
        { name: 'frontend-design', description: 'Design UIs\n  with care', argumentHint: '', kind: 'skill' },
        { name: 'compact', description: '', argumentHint: '' },
        { name: 'Review', description: 'duplicate', argumentHint: '' },
        { name: 'two words', description: "can't be typed", argumentHint: '' },
        { name: '/', description: 'empty', argumentHint: '' },
      ]),
    ).toEqual([
      { name: 'review', kind: 'command', description: 'Review changes', args: '[focus]' },
      { name: 'frontend-design', kind: 'skill', description: 'Design UIs with care' },
      { name: 'compact', kind: 'command' },
    ]);
  });

  it("offers model, reasoning and mode pickers like Paseo's app, never modes without safeguards", () => {
    const agent = claudeAgent({ effectiveThinkingOptionId: 'xhigh', lastUsage: { contextWindowUsedTokens: 50_000 } });
    const { controls, context } = agentControls(agent as never, CLAUDE_CATALOG as never);
    expect(controls.map((c) => [c.id, c.value])).toEqual([['model', 'claude-sonnet'], ['reasoning', 'xhigh'], ['mode', 'default']]);
    expect(controls[0]!.options.map((o) => o.label)).toEqual(['Sonnet', 'Opus']);
    expect(controls[1]!.options.map((o) => o.label)).toEqual(['Low', 'High', 'Extra high']);
    expect(controls[2]!.options.map((o) => [o.id, Boolean(o.autoApproves)])).toEqual([
      ['plan', false], ['default', false], ['acceptEdits', true], ['auto', true],
    ]);
    expect(context).toEqual({ used: 50_000, max: 200_000 });
    expect(controls.some((c) => c.disabledReason)).toBe(false);
  });

  it('shows what the agent really runs: aliases, models set elsewhere, defaults, a mode that was turned off here', () => {
    const ids = (overrides: object) => agentControls(claudeAgent(overrides) as never, CLAUDE_CATALOG as never).controls;
    // An alias finds its model; Opus has a single thinking level, so no reasoning picker.
    expect(ids({ runtimeInfo: { provider: 'claude', sessionId: 's1', model: 'opus' } }).map((c) => [c.id, c.value])).toEqual([
      ['model', 'claude-opus'], ['mode', 'default'],
    ]);
    expect(ids({ model: 'claude-experimental', runtimeInfo: undefined })[0]).toMatchObject({ value: null, valueLabel: 'claude-experimental' });
    expect(ids({ runtimeInfo: undefined })[0]).toMatchObject({ value: null, valueLabel: 'Default' });
    expect(ids({})[1]).toMatchObject({ id: 'reasoning', value: 'low' }); // the model's default level
    expect(ids({ currentModeId: 'bypassPermissions' })[2]).toMatchObject({ value: null, valueLabel: 'bypassPermissions' });
    expect(thinkingLabel({ id: 'max_effort' })).toBe('Max effort');
    expect(thinkingLabel({ id: 'x-high', label: null })).toBe('Extra high');
  });

  it('lets Hermes switch models only between turns, and reads stored agents from snapshots', () => {
    const hermes = (status: string) =>
      agentControls(
        claudeAgent({ provider: 'hermes', status, runtimeInfo: { provider: 'hermes', sessionId: 's', model: 'gpt' }, availableModes: HERMES_MODES }) as never,
        HERMES_CATALOG as never,
      ).controls;
    expect(hermes('running')[0]).toMatchObject({ id: 'model', disabledReason: HERMES_BUSY_MODEL });
    expect(hermes('idle')[0]).not.toHaveProperty('disabledReason');
    expect(hermes('idle')[1]!.options.map((o) => o.id)).toEqual(['default', 'accept_edits']);

    // Paseo only has it stored: no modes of its own yet, so the provider's are offered.
    const stored = claudeAgent({
      capabilities: { supportsStreaming: false },
      availableModes: [],
      currentModeId: 'plan',
      runtimeInfo: undefined,
      model: 'claude-sonnet',
    });
    expect(agentControls(stored as never, CLAUDE_CATALOG as never).controls.map((c) => [c.id, c.value])).toEqual([
      ['model', 'claude-sonnet'], ['reasoning', 'low'], ['mode', 'plan'],
    ]);
    // Without a catalog there's nothing to pick from but the agent's own modes.
    const bare = agentControls(claudeAgent({ lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 } }) as never, null);
    expect(bare).toEqual({ controls: [expect.objectContaining({ id: 'mode' })], context: { used: 10, max: 100 } });
  });

  it("reads image paths against the folder Paseo's app would use", () => {
    const cwd = '/home/me/code/app';
    expect(imageReadRoot('~/Pictures/cat.png', cwd)).toBe('~');
    expect(imageReadRoot('/home/me/code/app/shots/ui.png', cwd)).toBe(cwd);
    expect(imageReadRoot('/home/me/code/app/shots/ui.png', `${cwd}/`)).toBe(`${cwd}/`);
    expect(imageReadRoot('/home/me/code/application.png', cwd)).toBe('/'); // a sibling, not inside
    expect(imageReadRoot('/tmp/paseo-attachments-1/abc.png', cwd)).toBe('/');
    expect(imageReadRoot('shots/ui.png', cwd)).toBe(cwd);
  });

  it('tells a running agent from one Paseo only has in storage', () => {
    expect(agentLoaded({ status: 'idle', capabilities: { supportsStreaming: true } } as never)).toBe(true);
    expect(agentLoaded({ status: 'idle', capabilities: { supportsStreaming: false } } as never)).toBe(false);
    expect(agentLoaded({ status: 'closed', capabilities: { supportsStreaming: true } } as never)).toBe(false);
  });

  it('reads what started an agent from its labels: a Paseo parent first, else a Hermes chat', () => {
    const parentOf = (labels: Record<string, string>) => agentSummary(claudeAgent({ labels }) as never, 'Claude Code', 0);
    expect(parentOf({ [PARENT_AGENT_LABEL]: ' p1 ' }).parent).toEqual({ source: 'paseo', id: 'p1' });
    expect(parentOf({ [HERMES_PARENT_LABEL]: '20260927_101500_ab12cd' }).parent).toEqual({ source: 'hermes', id: '20260927_101500_ab12cd' });
    expect(parentOf({ [PARENT_AGENT_LABEL]: 'p1', [HERMES_PARENT_LABEL]: 'h1' }).parent).toEqual({ source: 'paseo', id: 'p1' });
    expect(parentOf({ [PARENT_AGENT_LABEL]: '  ', [HERMES_PARENT_LABEL]: 'h1' }).parent).toEqual({ source: 'hermes', id: 'h1' });
    const none: Array<Record<string, string>> = [{}, { [HERMES_PARENT_LABEL]: '' }, { 'paseo.open-agent-tab.x': 'true' }];
    for (const labels of none) {
      expect(parentOf(labels)).not.toHaveProperty('parent');
    }
    expect(parentOf({ [PARENT_AGENT_LABEL]: 'p1' })).not.toHaveProperty('parentId');
  });

  it('knows Hermes in Paseo by its ACP session id too, and passes on nothing else of how Paseo resumes it', () => {
    const persistence = {
      provider: 'hermes',
      sessionId: 'acp-5f0c2a8e',
      nativeHandle: 'acp-5f0c2a8e',
      metadata: { command: ['hermes', 'acp'], env: { API_KEY: 'obviously-fake-api-key' } },
    };
    const hermes = agentSummary(claudeAgent({ provider: 'hermes', persistence }) as never, 'Hermes', 0);
    expect(hermes).toMatchObject({ hermesInPaseo: true, aliases: [{ source: 'hermes', id: 'acp-5f0c2a8e' }] });
    expect(JSON.stringify(hermes)).not.toMatch(/obviously-fake-api-key|API_KEY|command/);
    // Other providers' sessions aren't Hermes chats; a Hermes agent without a session has none yet.
    expect(agentSummary(claudeAgent({ persistence: { ...persistence, provider: 'claude' } }) as never, 'Claude Code', 0)).not.toHaveProperty('aliases');
    expect(agentSummary(claudeAgent({ provider: 'hermes', persistence: null }) as never, 'Hermes', 0)).not.toHaveProperty('aliases');
  });

  it("gives a sub-agent an id under its agent's, one that fits in a URL", () => {
    expect(subagentRowId('5f0c2a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'toolu_01AbC')).toBe('5f0c2a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6:toolu_01AbC');
    const odd = subagentRowId('5f0c2a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'task/with spaces?');
    expect(odd).toMatch(/^5f0c2a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6:h-[0-9a-f]{32}$/);
    expect(subagentRowId('5f0c2a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'task/with spaces?')).toBe(odd);
    expect(subagentRowId('a', 'x'.repeat(151))).toMatch(/^a:h-/);
  });
});

// ---- timeline mirror ----------------------------------------------------------

function page(epoch: string, entries: Array<{ seq: number; item: object; turnId?: string }>, extra: object = {}) {
  const seqs = entries.map((e) => e.seq);
  return {
    epoch,
    reset: false,
    hasOlder: false,
    window: { minSeq: 1, maxSeq: Math.max(0, ...seqs), nextSeq: Math.max(0, ...seqs) + 1 },
    startCursor: entries.length ? { epoch, seq: Math.min(...seqs) } : null,
    endCursor: entries.length ? { epoch, seq: Math.max(...seqs) } : null,
    entries: entries.map((e) => ({
      item: e.item,
      turnId: e.turnId ?? 't1',
      timestamp: '2026-09-27T00:00:00Z',
      seqStart: e.seq,
      seqEnd: e.seq,
    })),
    ...extra,
  };
}

function recordingSink() {
  const log: string[] = [];
  const sink: MirrorSink = {
    reset: (rows) => log.push(`reset:${rows.length}`),
    upsert: (row: MirrorRow) => log.push(`upsert:${row.item.type}`),
    append: (_row, delta) => log.push(`append:${delta}`),
    status: (event) => log.push(`status:${event.type}`),
    failure: (err) => log.push(`failure:${String(err)}`),
  };
  return { log, sink };
}

const live = (seq: number, item: object, epoch = 'e1') => ({
  agentId: 'a1',
  event: { type: 'timeline', provider: 'pi', item, turnId: 't1' },
  timestamp: '2026-09-27T00:00:01Z',
  seq,
  epoch,
});

/** A timeline subscription like `DaemonClient.subscribeAgentTimeline` returns. */
const noSubscription = () => {
  const stop = (() => {}) as (() => void) & { ready: Promise<void> };
  stop.ready = Promise.resolve();
  return stop;
};

describe('paseo timeline mirror', () => {
  it.each(['assistant_message', 'reasoning'] as const)('reconciles cumulative catch-up %s without repeating chunks', async (type) => {
    const fetchAgentTimeline = vi.fn()
      .mockResolvedValueOnce(page('e1', [{ seq: 1, item: { type, text: 'Hello ' } }]))
      .mockResolvedValue(page('e1', [], {
        entries: [{ seqStart: 1, seqEnd: 2, turnId: 't1', timestamp: '2026-09-27T00:00:01Z', item: { type, text: 'Hello world' } }],
        endCursor: { epoch: 'e1', seq: 2 },
      }));
    const { sink, log } = recordingSink();
    const mirror = new AgentTimelineMirror({ subscribeAgentTimeline: noSubscription, fetchAgentTimeline } as never, 'a1', sink, new BackgroundGate('primary'));
    await mirror.loadTail();
    const keys = mirror.rows.map((r) => r.key);
    await mirror.catchUp();
    await mirror.catchUp();
    expect(mirror.rows.map((r) => r.item)).toEqual([{ type, text: 'Hello world' }]);
    expect(mirror.rows.map((r) => r.key)).toEqual(keys);
    expect(log).toContain(`upsert:${type}`);
    expect(log.filter((l) => l.startsWith('append:'))).toEqual([]);
    expect(fetchAgentTimeline.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: { epoch: 'e1', seq: 2 } });
    mirror.close();
  });

  it('applies buffered live chunks only after the cumulative catch-up cursor', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void;
    const fetchAgentTimeline = vi.fn()
      .mockResolvedValueOnce(page('e1', [{ seq: 1, item: { type: 'assistant_message', text: 'Hello ' } }]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const { sink, log } = recordingSink();
    const mirror = new AgentTimelineMirror({ subscribeAgentTimeline: noSubscription, fetchAgentTimeline } as never, 'a1', sink, new BackgroundGate('primary'));
    await mirror.loadTail();
    const catchUp = mirror.catchUp();
    mirror.handleLive(live(2, { type: 'assistant_message', text: 'world' }) as never);
    mirror.handleLive(live(3, { type: 'assistant_message', text: '!' }) as never);
    resolvePage(page('e1', [], {
      entries: [{ seqStart: 1, seqEnd: 2, turnId: 't1', timestamp: '2026-09-27T00:00:01Z', item: { type: 'assistant_message', text: 'Hello world' } }],
      endCursor: { epoch: 'e1', seq: 2 },
    }));
    await catchUp;
    expect(mirror.rows.map((r) => r.item)).toEqual([{ type: 'assistant_message', text: 'Hello world!' }]);
    expect(log.filter((l) => l.startsWith('append:'))).toEqual(['append:!']);
    mirror.close();
  });

  it('reconciles overlapping tool completion and advances from the returned cursor', async () => {
    const tool = { type: 'tool_call', callId: 'fake-tool', name: 'Read', status: 'running', detail: { type: 'unknown' } };
    const fetchAgentTimeline = vi.fn()
      .mockResolvedValueOnce(page('e1', [{ seq: 1, item: tool }, { seq: 2, item: { type: 'assistant_message', text: 'Done' } }]))
      .mockResolvedValueOnce(page('e1', [], {
        entries: [
          { seqStart: 1, seqEnd: 6, turnId: 't1', timestamp: '2026-09-27T00:00:01Z', item: { ...tool, status: 'completed' } },
          { seqStart: 3, seqEnd: 3, turnId: 't1', timestamp: '2026-09-27T00:00:01Z', item: { type: 'user_message', text: 'Next' } },
        ],
        endCursor: { epoch: 'e1', seq: 7 },
      }))
      .mockResolvedValue(page('e1', []));
    const { sink, log } = recordingSink();
    const mirror = new AgentTimelineMirror({ subscribeAgentTimeline: noSubscription, fetchAgentTimeline } as never, 'a1', sink, new BackgroundGate('primary'));
    await mirror.loadTail();
    await mirror.catchUp();
    expect(mirror.rows[0]?.item).toMatchObject({ status: 'completed' });
    expect(mirror.rows.map((r) => r.seqStart)).toEqual([1, 2, 3]);
    expect(log).toContain('upsert:tool_call');
    await mirror.catchUp();
    expect(fetchAgentTimeline.mock.calls.at(-1)?.[1]).toMatchObject({ cursor: { epoch: 'e1', seq: 7 } });
    mirror.handleLive(live(7, { type: 'assistant_message', text: 'Replay' }) as never);
    mirror.handleLive(live(8, { type: 'assistant_message', text: 'Live' }) as never);
    expect(mirror.rows.at(-1)?.item).toEqual({ type: 'assistant_message', text: 'Live' });
    mirror.close();
  });

  it('merges streamed chunks, ignores replays, and catches up on gaps', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      subscribeAgentTimeline: noSubscription,
      fetchAgentTimeline: async (_id: string, options: Record<string, unknown>) => {
        calls.push(options);
        if (options.direction === 'tail') {
          return page('e1', [
            { seq: 1, item: { type: 'user_message', text: 'hi' } },
            { seq: 2, item: { type: 'assistant_message', text: 'Hel' } },
          ]);
        }
        return page('e1', [], {
          entries: [{ seqStart: 2, seqEnd: 4, turnId: 't1', timestamp: '2026-09-27T00:00:01Z', item: { type: 'assistant_message', text: 'Hello!' } }],
          endCursor: { epoch: 'e1', seq: 4 },
        });
      },
    };
    const { log, sink } = recordingSink();
    const mirror = new AgentTimelineMirror(client as never, 'a1', sink, new BackgroundGate('primary'));
    await mirror.loadTail();
    expect(log).toEqual(['reset:2']);

    mirror.handleLive(live(2, { type: 'assistant_message', text: 'Hel' }) as never); // replay: ignored
    mirror.handleLive(live(3, { type: 'assistant_message', text: 'lo' }) as never);
    expect(mirror.rows.at(-1)!.item).toMatchObject({ text: 'Hello' });
    expect(log.at(-1)).toBe('append:lo');

    mirror.handleLive(live(5, { type: 'assistant_message', text: '?' }) as never); // gap after 3
    await expect.poll(() => calls.some((c) => c.direction === 'after' && c.projection === 'projected')).toBe(true);
    await expect.poll(() => mirror.rows.at(-1)!.item).toMatchObject({ text: 'Hello!' });
  });

  it('reloads everything when the agent restarts with a new epoch', async () => {
    let tailCalls = 0;
    const client = {
      subscribeAgentTimeline: noSubscription,
      fetchAgentTimeline: async () => {
        tailCalls += 1;
        return page(tailCalls === 1 ? 'e1' : 'e2', [{ seq: 1, item: { type: 'user_message', text: 'hi' } }]);
      },
    };
    const { log, sink } = recordingSink();
    const mirror = new AgentTimelineMirror(client as never, 'a1', sink, new BackgroundGate('primary'));
    await mirror.loadTail();
    mirror.handleLive(live(1, { type: 'assistant_message', text: 'new' }, 'e2') as never);
    await expect.poll(() => log.filter((l) => l.startsWith('reset')).length).toBe(2);
  });
});

// ---- adapter with a fake daemon -------------------------------------------------

interface SendOptions {
  messageId: string;
  activeTurnBehavior?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: Array<Record<string, unknown>>;
}

/** `extra`: more agents to list, as overrides of a running, loaded agent. */
function fakeDaemon(extra: Array<{ id: string } & Record<string, unknown>> = []) {
  const handlers = new Map<string, Array<(m: { payload: unknown }) => void>>();
  const timelineHandlers = new Map<string, {
    update: (m: { type: string; payload: unknown }) => void;
    error?: (error: unknown) => void;
  }>();
  const timelineSubscriptions: string[] = [];
  const timelineReleases: string[] = [];
  const observed: Array<{ events: string[]; update: (m: { type: string; payload: unknown }) => void }> = [];
  let statusListener: ((s: { status: string; reason?: string }) => void) | undefined;
  const responses: Array<{ agentId: string; requestId: string; response: unknown }> = [];
  const agent = (id: string, pendingPermissions: unknown[] = [], overrides: object = {}) => ({
    id,
    provider: 'hermes',
    cwd: '/home/me/code/app',
    title: `Agent ${id}`,
    status: 'running',
    updatedAt: '2026-09-27T00:00:00Z',
    pendingPermissions,
    labels: {},
    capabilities: { supportsStreaming: true },
    ...overrides,
  });
  const client = {
    subscribeConnectionStatus: (l: (s: { status: string; reason?: string }) => void) => {
      statusListener = l;
      return () => {};
    },
    on: (type: string, h: (m: { payload: unknown }) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => { handlers.set(type, (handlers.get(type) ?? []).filter((handler) => handler !== h)); };
    },
    connect: async () => statusListener?.({ status: 'connected' }),
    close: async () => {},
    fetchAgents: async () => ({
      entries: [
        { agent: agent('a1', [shellRequest]), project: null },
        { agent: agent('a2', [questionRequest]), project: null },
        ...extra.map((overrides) => ({ agent: agent(overrides.id, [], overrides), project: null })),
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    observeAgents: () => ({
      ready: client.fetchAgents().then((page) => ({ ...page, subscriptionId: 'fake-agents' })),
      subscribe: () => () => {},
      release: async () => {},
    }),
    fetchAgentTimeline: async (agentId: string) => {
      loads.push(['timeline', agentId]);
      return state.timeline ?? page('e1', [], { agent: state.liveAgent });
    },
    fetchAgent: async (arg: string | { agentId: string }) => {
      const agentId = typeof arg === 'string' ? arg : arg.agentId;
      loads.push(['fetchAgent', agentId]);
      const overrides = extra.find((e) => e.id === agentId);
      return overrides ? { agent: agent(agentId, [], { ...overrides, ...changed[agentId] }), project: null } : null;
    },
    setAgentMode: async (agentId: string, modeId: string) => {
      configCalls.push(['mode', agentId, modeId]);
      changed[agentId] = { ...changed[agentId], currentModeId: modeId };
      return state.notice;
    },
    setAgentModel: async (agentId: string, modelId: string | null) => {
      configCalls.push(['model', agentId, modelId]);
      changed[agentId] = { ...changed[agentId], model: modelId, runtimeInfo: { provider: 'claude', sessionId: 's1', model: modelId } };
    },
    setAgentThinkingOption: async (agentId: string, optionId: string | null) => {
      configCalls.push(['reasoning', agentId, optionId]);
      changed[agentId] = { ...changed[agentId], thinkingOptionId: optionId, effectiveThinkingOptionId: optionId };
      return state.notice;
    },
    setAgentFeature: async (agentId: string, featureId: string, value: unknown) => {
      configCalls.push(['feature', agentId, featureId, value]);
    },
    readFile: async (cwd: string, path: string, _requestId?: string, maxBytes?: number) => {
      reads.push({ cwd, path, maxBytes });
      if (state.readError) throw new Error(state.readError);
      const bytes = new Uint8Array(PNG);
      return { bytes, mime: 'image/png', size: bytes.length, path, kind: state.readKind, modifiedAt: '2026-09-27T00:00:00Z' };
    },
    sendAgentMessage: async (agentId: string, text: string, options: SendOptions) => {
      sent.push({ agentId, text, options });
      if (state.failSend) throw new Error('agent is gone');
    },
    uploadFile: async (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => {
      uploads.push(input);
      if (state.failUpload) return { requestId: 'u', file: null, error: 'disk full' };
      const id = `upload_${uploads.length}`;
      const path = `/home/me/.paseo/uploads/${id}/${input.fileName}`;
      const { fileName, mimeType } = input;
      return { requestId: 'u', file: { type: 'uploaded_file', id, fileName, mimeType, size: input.bytes.byteLength, path }, error: null };
    },
    listCommands: async (agentId: string) => {
      commandCalls.push(agentId);
      if (state.commandsThrow) throw new Error('timed out');
      return { agentId, requestId: 'c', commands: state.commands, error: state.commandsError };
    },
    respondToPermissionAndWait: async (agentId: string, requestId: string, response: unknown) => {
      if (state.failResponses) throw new Error('timed out');
      responses.push({ agentId, requestId, response });
      return {};
    },
    getProvidersSnapshot: async (options?: { cwd?: string }) => {
      snapshotCwds.push(options?.cwd ?? null);
      return { requestId: 'p', cwd: options?.cwd ?? '/home/me', entries: providerEntries() };
    },
    // Lets the client wait for Paseo to finish asking the agent CLIs, and list sub-agents (older daemons can't).
    getLastServerInfoMessage: () =>
      state.waitable || state.canListSubagents
        ? {
            features: {
              ...(state.waitable ? { providersSnapshotCwd: true } : {}),
              ...(state.canListSubagents ? { providerSubagents: true } : {}),
            },
          }
        : null,
    // Since 0.9.2 the daemon streams an agent's timeline only to subscribers.
    subscribeAgentTimeline: (agentId: string, handler: Parameters<DaemonClient['subscribeAgentTimeline']>[1]) =>
      timelineClient.subscribeAgentTimeline(agentId, handler),
    listProviderSubagents: async (parentAgentId: string) => {
      subagentLists.push(parentAgentId);
      return { requestId: 's', parentAgentId, subagents: state.subagents[parentAgentId] ?? [], error: null };
    },
    // The 0.9.2 client waits on provider snapshots through an event subscription.
    observeEvents: (events: string[]) => {
      const entry = { events, update: (_m: { type: string; payload: unknown }) => {} };
      observed.push(entry);
      return {
        subscriptionId: `obs-${observed.length}`,
        ready: Promise.resolve({ subscriptionId: `obs-${observed.length}` }),
        subscribe: (o: { update: (m: { type: string; payload: unknown }) => void }) => {
          entry.update = o.update;
          return () => { entry.update = () => {}; };
        },
        release: async () => {
          const i = observed.indexOf(entry);
          if (i >= 0) observed.splice(i, 1);
        },
      };
    },
    fetchWorkspaces: async () => ({ entries: [{ id: 'ws1', workspaceDirectory: '/home/me/code/app', projectRootPath: '/home/me/code/app', projectDisplayName: 'app' }] }),
    listProjects: async () => ({ projects: [] }),
    createAgent: async (options: Record<string, unknown>) => {
      created.push(options);
      return agent('new-agent');
    },
    cancelAgent: async (id: string) => { actions.push(['interrupt', id]); },
    archiveAgent: async (id: string) => { actions.push(['archive', id]); },
    refreshAgent: async (id: string) => { actions.push(['restore', id]); },
    deleteAgent: async (id: string) => { actions.push(['delete', id]); },
    // Like Paseo's file explorer: realpath the cwd (ENOENT when missing, ENOTDIR below a file), then stat the entry.
    listDirectory: async (cwd: string, path: string) => {
      const full = path === '.' ? cwd : `${cwd === '/' ? '' : cwd}/${path}`;
      if ([...state.files].some((f) => cwd.startsWith(`${f}/`))) throw new Error(`ENOTDIR: not a directory, realpath '${cwd}'`);
      if (!state.folders.has(cwd) && !state.files.has(cwd)) throw new Error(`ENOENT: no such file or directory, realpath '${cwd}'`);
      if (state.files.has(full)) throw new Error('Requested path is not a directory');
      if (!state.folders.has(full)) throw new Error(`ENOENT: no such file or directory, stat '${full}'`);
      return { path, entries: [] };
    },
    createProjectDirectory: async (input: { parentPath: string; name: string }) => {
      folderCreates.push(input);
      const directoryPath = `${input.parentPath === '/' ? '' : input.parentPath}/${input.name}`;
      if (state.folders.has(directoryPath)) {
        return { directoryPath, project: null, error: `Directory already exists: ${directoryPath}`, errorCode: 'directory_exists' };
      }
      if (!state.folders.has(input.parentPath)) {
        return { directoryPath: null, project: null, error: `Parent directory not found: ${input.parentPath}`, errorCode: 'parent_directory_not_found' };
      }
      state.folders.add(directoryPath);
      return { directoryPath, project: { projectKey: directoryPath }, error: null, errorCode: null };
    },
  };
  const state = {
    failResponses: false,
    failSend: false,
    failUpload: false,
    timeline: null as ReturnType<typeof page> | null,
    timelineFailure: null as string | null,
    liveAgent: null as object | null,
    commands: [
      { name: '/review', description: 'Review the changes', argumentHint: '[focus]', kind: 'command' },
      { name: 'tdd', description: 'Test first', argumentHint: '', kind: 'skill' },
    ] as Array<Record<string, unknown>>,
    commandsError: null as string | null,
    commandsThrow: false,
    claudeStatus: 'ready',
    waitable: true,
    notice: null as { type: string; message: string } | null,
    readKind: 'image',
    readError: null as string | null,
    /** The daemon can list an agent's sub-agents. */
    canListSubagents: true,
    /** What listing an agent's sub-agents answers, by agent. */
    subagents: {} as Record<string, object[]>,
    /** Folders and files on disk, as the daemon (running as the owner) sees them. */
    folders: new Set(['/', '/home', '/home/me', '/home/me/code', '/home/me/code/app']),
    files: new Set(['/home/me/notes.txt']),
  };
  const folderCreates: Array<{ parentPath: string; name: string }> = [];
  const actions: Array<[string, string]> = [];
  /** Agents whose sub-agents were listed (a call that would resume a stored agent). */
  const subagentLists: string[] = [];
  const reads: Array<{ cwd: string; path: string; maxBytes: number | undefined }> = [];
  const providerEntries = () => [
    { provider: 'claude', status: state.claudeStatus, enabled: true, label: 'Claude Code', defaultModeId: 'auto', ...CLAUDE_CATALOG },
    { provider: 'hermes', status: 'ready', enabled: true, label: 'Hermes', ...HERMES_CATALOG },
    { provider: 'pi', status: 'ready', enabled: true, label: 'Pi', modes: [] },
    { provider: 'codex', status: 'unavailable', enabled: true, modes: [] },
  ];
  const created: Array<Record<string, unknown>> = [];
  const sent: Array<{ agentId: string; text: string; options: SendOptions }> = [];
  const uploads: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }> = [];
  const commandCalls: string[] = [];
  /** Calls that make Paseo load (resume) an agent. */
  const loads: Array<[string, string]> = [];
  const configCalls: unknown[][] = [];
  const snapshotCwds: Array<string | null> = [];
  /** What the setters changed, as fetchAgent reports it. */
  const changed: Record<string, object> = {};
  // Exercise the SDK's actual readiness/error lifecycle without opening a socket.
  const timelineClient = new DaemonClient({ url: 'ws://127.0.0.1:8892', clientId: 'fake-timeline', logger: quietLog as never });
  vi.spyOn(timelineClient, 'observeTimeline').mockImplementation(([agentId]) => {
    timelineSubscriptions.push(agentId!);
    const ready = state.timelineFailure
      ? Promise.reject(new Error(state.timelineFailure))
      : Promise.resolve({ subscriptionId: 'fake-timeline-subscription' });
    let released = false;
    return {
      subscriptionId: 'fake-timeline-subscription',
      ready,
      subscribe: (observer: { update: (m: { type: string; payload: unknown }) => void; error?: (error: unknown) => void }) => {
        timelineHandlers.set(agentId!, observer);
        return () => { timelineHandlers.delete(agentId!); };
      },
      release: async () => {
        if (released) return;
        released = true;
        timelineReleases.push(agentId!);
        timelineHandlers.delete(agentId!);
      },
    } as never;
  });
  const emit = (type: string, payload: unknown) => {
    const gated = ['agent_permission_request', 'agent_permission_resolved', 'agent.provider_subagents.update'];
    if (gated.includes(type) && !observed.some((o) => o.events.includes(type))) return;
    handlers.get(type)?.forEach((h) => h({ payload }));
    if (['agent_stream', 'agent.timeline.replacement', 'agent.timeline.subscription_restored'].includes(type)) {
      timelineHandlers.get((payload as { agentId: string }).agentId)?.update({ type, payload });
    }
    observed.forEach((o) => {
      if (o.events.includes(type)) o.update({ type, payload });
    });
  };
  /** The socket drops and comes back: Signalbox lists everything again. */
  const reconnect = () => {
    statusListener?.({ status: 'disconnected' });
    statusListener?.({ status: 'connected' });
  };
  /** The socket drops, optionally with the daemon's close reason ("Incorrect password"). */
  const drop = (reason?: string) => statusListener?.({ status: 'disconnected', ...(reason ? { reason } : {}) });
  const failTimeline = (agentId: string, error: string) => timelineHandlers.get(agentId)?.error?.(new Error(error));
  return {
    client, responses, emit, reconnect, drop, created, sent, uploads, commandCalls, loads, configCalls, snapshotCwds, reads, state, agent,
    providerEntries, subagentLists, folderCreates, observed, timelineSubscriptions, timelineReleases, failTimeline, actions,
  };
}

async function setup(extra: Parameters<typeof fakeDaemon>[0] = [], background = new BackgroundGate('primary')) {
  const daemon = fakeDaemon(extra);
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  const browser = hub.add({ readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} } as never, 'x');
  const adapter = new PaseoAdapter('ws://127.0.0.1:8895', hub, quietLog, 'cid_signalbox_test', () => daemon.client as never, background);
  adapter.start();
  await expect.poll(() => adapter.status().state).toBe('connected');
  // Let what the start asked the fake (e.g. each agent's sub-agents) come back.
  await new Promise((resolve) => setImmediate(resolve));
  /** Items pushed to a browser that has `id` open. */
  const itemsOf = (id: string) => {
    const byId = new Map<string, TimelineItem>();
    for (const e of events) {
      if ((e.type !== 'items_upsert' && e.type !== 'items_replace') || e.conversationId !== id) continue;
      for (const item of e.items) byId.set(item.id, item);
    }
    return [...byId.values()];
  };
  return { adapter, daemon, events, itemsOf, open: (id: string) => hub.subscribe(browser, 'paseo', id) };
}

describe('shadow automatic reads', () => {
  it.each(['response', 'error'] as const)('keeps newer reopened history when an older open returns an obsolete %s', async outcome => {
    const agentId = 'fake-overlapping-open';
    const { adapter, daemon } = await setup([{ id: agentId }], new BackgroundGate('shadow'));
    try {
      daemon.state.timeline = page('fake-epoch', [{ seq: 1, item: { type: 'assistant_message', text: 'A' } }]);
      await adapter.getConversation(agentId, true);
      const fetch = vi.spyOn(daemon.client, 'fetchAgentTimeline');
      daemon.reconnect();
      await new Promise(resolve => setImmediate(resolve));
      expect(await adapter.getConversation(agentId)).toMatchObject({ needsOpen: true });
      expect(fetch).not.toHaveBeenCalled();
      let resolveOlder!: (value: ReturnType<typeof page>) => void;
      let rejectOlder!: (error: Error) => void;
      const older = new Promise<ReturnType<typeof page>>((resolve, reject) => { resolveOlder = resolve; rejectOlder = reject; });
      fetch.mockReturnValueOnce(older).mockResolvedValueOnce(page('fake-epoch', [
        { seq: 1, item: { type: 'assistant_message', text: 'A' } },
        { seq: 2, item: { type: 'assistant_message', text: 'B' } },
      ]));
      const first = adapter.getConversation(agentId, true);
      const firstResult = expect(first).resolves.toMatchObject({ needsOpen: false, items: [{ text: 'AB' }] });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(await adapter.getConversation(agentId, true)).toMatchObject({ needsOpen: false, items: [{ text: 'AB' }] });
      if (outcome === 'response') resolveOlder(page('fake-epoch', [{ seq: 1, item: { type: 'assistant_message', text: 'A' } }]));
      else rejectOlder(new Error('fake-obsolete-open-error'));
      await firstResult;
      const commandCalls = daemon.commandCalls.length;
      adapter.setWatching(agentId, true);
      expect(await adapter.getConversation(agentId)).toMatchObject({ needsOpen: false, items: [{ text: 'AB' }] });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(daemon.commandCalls).toHaveLength(commandCalls);
    } finally { adapter.stop(); }
  });

  it('uses only cached history on automatic reads and resubscriptions, even after reconnect', async () => {
    const { adapter, daemon } = await setup([], new BackgroundGate('shadow'));
    try {
      const fetch = vi.spyOn(daemon.client, 'fetchAgentTimeline');
      adapter.setWatching('a1', true);
      expect(await adapter.getConversation('a1')).toMatchObject({ needsOpen: true, items: [] });
      await adapter.listCommands('a1');
      expect(fetch).not.toHaveBeenCalled();
      expect(daemon.timelineSubscriptions).toEqual([]);
      expect(daemon.commandCalls).toEqual([]);
      await adapter.getConversation('a1', true);
      expect(fetch).toHaveBeenCalledOnce();
      fetch.mockClear();
      daemon.reconnect();
      await new Promise((resolve) => setImmediate(resolve));
      adapter.setWatching('a1', true);
      expect(await adapter.getConversation('a1')).toMatchObject({ needsOpen: true });
      expect(fetch).not.toHaveBeenCalled();
      await adapter.getConversation('a1', true);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { adapter.stop(); }
  });

  it('never discovers subagents by RPC at bootstrap, reconnect, or agent update', async () => {
    const { adapter, daemon } = await setup([claudeAgent()], new BackgroundGate('shadow'));
    try {
      expect(daemon.subagentLists).toEqual([]);
      daemon.reconnect();
      await new Promise((resolve) => setImmediate(resolve));
      daemon.emit('agent_update', { kind: 'upsert', agent: daemon.agent('fake-new-parent', [], claudeAgent({ id: 'fake-new-parent' })) });
      await new Promise((resolve) => setImmediate(resolve));
      expect(daemon.subagentLists).toEqual([]);
    } finally { adapter.stop(); }
  });
});

describe.each(['primary', 'shadow'] as const)('%s optional command discovery on deliberate opens', role => {
  it.each(['timeout', 'daemon error'] as const)('returns loaded history and approvals after a command %s', async failure => {
    const { adapter, daemon } = await setup([], new BackgroundGate(role));
    try {
      daemon.state.timeline = page('e1', [{ seq: 1, item: { type: 'user_message', text: 'Demo history.' } }]);
      daemon.state.commandsThrow = failure === 'timeout';
      daemon.state.commandsError = failure === 'daemon error' ? 'Demo command discovery failed.' : null;
      const detail = await adapter.getConversation('a1', true);
      expect(detail.items).toEqual([{ kind: 'user', id: 's-e1-1', text: 'Demo history.' }]);
      expect(detail.approvals).toHaveLength(1);
      expect(detail.conversation.id).toBe('a1');
      expect(daemon.loads).toEqual([['timeline', 'a1']]);
      expect(daemon.commandCalls).toEqual(['a1']);
      if (role === 'shadow') {
        await adapter.getConversation('a1'); await adapter.listCommands('a1');
        expect(daemon.commandCalls).toEqual(['a1']);
        expect(daemon.loads).toEqual([['timeline', 'a1']]);
      }
      // A failed optional lookup is not cached: a later deliberate open can discover commands.
      daemon.state.commandsThrow = false; daemon.state.commandsError = null;
      await adapter.getConversation('a1', true);
      expect(await adapter.listCommands('a1')).toMatchObject([{ name: 'review' }, { name: 'tdd' }]);
      expect(daemon.commandCalls).toEqual(['a1', 'a1']);
    } finally { adapter.stop(); }
  });
});

describe('shared Paseo timeline authorization', () => {
  const agentId = 'fake-shared-agent';
  const history = (seq: number, text: string) => {
    const snapshot = page('fake-epoch', [{ seq, item: { type: 'assistant_message', text } }]);
    return { ...snapshot, startCursor: { epoch: 'fake-epoch', seq: 1 }, entries: snapshot.entries.map(entry => ({ ...entry, seqStart: 1 })) };
  };

  it.each(['sequence gap', 'reconnect', 'replacement'] as const)('keeps primary updates after the opening device is revoked: %s', async trigger => {
    const { adapter, daemon, events, open } = await setup([{ id: agentId }]);
    const owner = new AbortController(); const other = new AbortController();
    const scopes: Array<AbortSignal | undefined> = [];
    const fetch = daemon.client.fetchAgentTimeline;
    vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementation(id => { scopes.push(deviceSignal()); return fetch(id); });
    try {
      open(agentId);
      daemon.state.timeline = history(1, 'A');
      await withDeviceSignal(owner.signal, () => adapter.getConversation(agentId));
      owner.abort();
      daemon.state.timeline = history(3, 'ABC');
      if (trigger === 'sequence gap') daemon.emit('agent_stream', { ...live(3, { type: 'assistant_message', text: 'C' }, 'fake-epoch'), agentId });
      else if (trigger === 'reconnect') daemon.reconnect();
      else daemon.emit('agent.timeline.replacement', { agentId, epoch: 'fake-epoch' });
      await expect.poll(() => events.some(event => (event.type === 'items_replace' || event.type === 'items_upsert')
        && event.conversationId === agentId && event.items.some(item => item.kind === 'assistant' && item.text === 'ABC'))).toBe(true);
      expect((await withDeviceSignal(other.signal, () => adapter.getConversation(agentId))).items).toMatchObject([{ text: 'ABC' }]);
      daemon.emit('agent_stream', { ...live(4, { type: 'assistant_message', text: 'D' }, 'fake-epoch'), agentId });
      expect((await withDeviceSignal(other.signal, () => adapter.getConversation(agentId))).items).toMatchObject([{ text: 'ABCD' }]);
      expect(scopes).toEqual([owner.signal, undefined]);
      expect(daemon.timelineSubscriptions).toEqual([agentId]);
      expect(daemon.timelineReleases).toEqual([]);
    } finally { adapter.stop(); }
  });

  it('reopens a shadow mirror with the current device after its owner is revoked and the daemon reconnects', async () => {
    const { adapter, daemon } = await setup([{ id: agentId }], new BackgroundGate('shadow'));
    const owner = new AbortController(); const other = new AbortController();
    const scopes: Array<AbortSignal | undefined> = [];
    const fetch = daemon.client.fetchAgentTimeline;
    vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementation(id => { scopes.push(deviceSignal()); return fetch(id); });
    const subscribe = vi.spyOn(daemon.client, 'subscribeAgentTimeline');
    try {
      daemon.state.timeline = history(1, 'A');
      await withDeviceSignal(owner.signal, () => adapter.getConversation(agentId, true));
      owner.abort(); daemon.reconnect();
      await new Promise(resolve => setImmediate(resolve));
      expect(await withDeviceSignal(other.signal, () => adapter.getConversation(agentId))).toMatchObject({ needsOpen: true });
      expect(scopes).toEqual([owner.signal]);
      daemon.state.timeline = history(3, 'ABC');
      expect(await withDeviceSignal(other.signal, () => adapter.getConversation(agentId, true))).toMatchObject({ needsOpen: false, items: [{ text: 'ABC' }] });
      expect(scopes).toEqual([owner.signal, other.signal]);
      expect(subscribe).toHaveBeenCalledOnce();
      expect(daemon.timelineReleases).toEqual([]);
    } finally { adapter.stop(); }
  });

  it('checks the current device after subscription readiness without retiring the shared subscription', async () => {
    const { adapter, daemon } = await setup([{ id: agentId }], new BackgroundGate('shadow'));
    const device = new AbortController(); const other = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const subscribe = daemon.client.subscribeAgentTimeline;
    const scopes: Array<AbortSignal | undefined> = [];
    vi.spyOn(daemon.client, 'subscribeAgentTimeline').mockImplementation((id, handler) => {
      scopes.push(deviceSignal());
      return Object.assign(subscribe(id, handler), { ready: waiting });
    });
    const fetch = vi.spyOn(daemon.client, 'fetchAgentTimeline');
    try {
      const pending = withDeviceSignal(device.signal, () => adapter.getConversation(agentId, true));
      const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
      device.abort(); ready(); await rejected;
      expect(fetch).not.toHaveBeenCalled();
      expect(scopes).toEqual([undefined]);
      expect(daemon.timelineReleases).toEqual([]);
      daemon.state.timeline = history(1, 'A');
      expect(await withDeviceSignal(other.signal, () => adapter.getConversation(agentId, true))).toMatchObject({ items: [{ text: 'A' }] });
      expect(daemon.timelineSubscriptions).toEqual([agentId]);
    } finally { ready(); adapter.stop(); }
  });

  it.each(['older', 'newer'] as const)('isolates a revoked %s reader from another device opening the same mirror', async revokedReader => {
    const { adapter, daemon } = await setup([{ id: agentId }], new BackgroundGate('shadow'));
    const owner = new AbortController(); const revoked = new AbortController(); const other = new AbortController();
    const pages: Array<(value: ReturnType<typeof page>) => void> = [];
    try {
      daemon.state.timeline = history(1, 'A');
      await withDeviceSignal(owner.signal, () => adapter.getConversation(agentId, true));
      owner.abort(); daemon.reconnect();
      await new Promise(resolve => setImmediate(resolve));
      vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementation(() => new Promise(resolve => { pages.push(resolve); }));
      const first = revokedReader === 'older' ? revoked : other;
      const second = revokedReader === 'older' ? other : revoked;
      const reads = [withDeviceSignal(first.signal, () => adapter.getConversation(agentId, true)),
        withDeviceSignal(second.signal, () => adapter.getConversation(agentId, true))]
        .map(read => read.then(detail => ({ detail }), error => ({ error })));
      const revokedIndex = revokedReader === 'older' ? 0 : 1;
      await expect.poll(() => pages.length).toBe(2);
      revoked.abort();
      expect(await reads[revokedIndex]).toMatchObject({ error: { status: 403 } });
      expect(daemon.timelineReleases).toEqual([]);
      pages[1 - revokedIndex]!(history(3, 'ABC'));
      expect(await reads[1 - revokedIndex]).toMatchObject({ detail: { items: [{ text: revokedReader === 'older' ? 'ABC' : 'A' }] } });
      pages[revokedIndex]!(history(4, 'Obsolete response'));
      await new Promise(resolve => setImmediate(resolve));
      expect(daemon.timelineSubscriptions).toEqual([agentId]);
      expect(daemon.timelineReleases).toEqual([]);
      expect((await withDeviceSignal(other.signal, () => adapter.getConversation(agentId))).items).toMatchObject([{ text: revokedReader === 'older' ? 'ABC' : 'A' }]);
      // The revoked newer read invalidated the older page: the live device can retry.
      if (revokedReader === 'newer') {
        const retry = withDeviceSignal(other.signal, () => adapter.getConversation(agentId, true));
        await expect.poll(() => pages.length).toBe(3);
        pages[2]!(history(3, 'ABC'));
        expect(await retry).toMatchObject({ needsOpen: false, items: [{ text: 'ABC' }] });
      }
    } finally { for (const resolve of pages) resolve(history(3, 'ABC')); adapter.stop(); }
  });

  it('runs catch-up from buffered events outside the explicit loader device context', async () => {
    const { adapter, daemon } = await setup([{ id: agentId }]);
    const device = new AbortController();
    const scopes: Array<AbortSignal | undefined> = [];
    vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementationOnce(async () => {
      scopes.push(deviceSignal());
      daemon.emit('agent_stream', { ...live(3, { type: 'assistant_message', text: 'C' }, 'fake-epoch'), agentId });
      return history(1, 'A');
    }).mockImplementationOnce(async () => { scopes.push(deviceSignal()); return history(3, 'ABC'); });
    try {
      await withDeviceSignal(device.signal, () => adapter.getConversation(agentId));
      expect(scopes).toEqual([device.signal, undefined]);
      device.abort();
      expect((await adapter.getConversation(agentId)).items).toMatchObject([{ text: 'ABC' }]);
      expect(daemon.timelineReleases).toEqual([]);
    } finally { adapter.stop(); }
  });
});

describe('paseo subscription lifecycle', () => {
  it('finishes an unwatched thirteenth open before evicting its mirror', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `fake-cache-${i}`);
    const { adapter, daemon } = await setup(ids.map((id) => ({ id })));
    for (const id of ids.slice(0, 12)) {
      adapter.setWatching(id, true);
      await adapter.getConversation(id);
    }
    daemon.state.timeline = page('e1', [{ seq: 1, item: { type: 'assistant_message', text: 'Completion' } }]);
    const result = await adapter.getConversation(ids[12]!);
    expect(result.items).toEqual([expect.objectContaining({ text: 'Completion' })]);
    expect(daemon.timelineReleases).toEqual([ids[12]]);
    expect(daemon.timelineSubscriptions).toHaveLength(13);
    await adapter.getConversation(ids[0]!);
    expect(daemon.timelineSubscriptions).toHaveLength(13);
    adapter.stop();
  });

  it('protects a shared mirror until every concurrent open has built its response', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `fake-concurrent-${i}`);
    const { adapter, daemon } = await setup(ids.map((id) => ({ id })));
    for (const id of ids.slice(0, 12)) {
      adapter.setWatching(id, true);
      await adapter.getConversation(id);
    }
    const pages: Array<(value: ReturnType<typeof page>) => void> = [];
    vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementation(() => new Promise((resolve) => pages.push(resolve)));
    const first = adapter.getConversation(ids[12]!);
    const second = adapter.getConversation(ids[12]!);
    void first.catch(() => {});
    void second.catch(() => {});
    await expect.poll(() => pages.length).toBe(2);
    pages[0]!(page('e1', [{ seq: 1, item: { type: 'assistant_message', text: 'First' } }]));
    // The older response is obsolete, but its reader must leave the shared mirror alive.
    expect(await first).toMatchObject({ items: [] });
    expect(daemon.timelineReleases).toEqual([]);
    pages[1]!(page('e1', [{ seq: 1, item: { type: 'assistant_message', text: 'Second' } }]));
    expect(await second).toMatchObject({ items: [expect.objectContaining({ text: 'Second' })] });
    expect(daemon.timelineReleases).toEqual([ids[12]]);
    adapter.stop();
  });

  it('owns permission and subagent subscriptions through reconnect and releases them on stop', async () => {
    const { adapter, daemon, events } = await setup([claudeAgent()]);
    const subscribed = () => daemon.observed.flatMap((o) => o.events);
    expect(subscribed()).toEqual(expect.arrayContaining([
      'agent_permission_request', 'agent_permission_resolved', 'agent.provider_subagents.update',
    ]));
    // Another Paseo client answers this request; no local response or agent update follows.
    daemon.emit('agent_permission_resolved', { agentId: 'a1', requestId: shellRequest.id });
    expect(adapter.listApprovals().some((a) => a.id === shellRequest.id)).toBe(false);
    expect(daemon.responses).toEqual([]);
    const request = { ...shellRequest, id: 'fake-new-permission' };
    daemon.emit('agent_permission_request', { agentId: 'a1', request });
    expect(adapter.listApprovals().some((a) => a.id === request.id)).toBe(true);
    daemon.emit('agent_permission_resolved', { agentId: 'a1', requestId: request.id });
    expect(adapter.listApprovals().some((a) => a.id === request.id)).toBe(false);

    daemon.reconnect();
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscribed().filter((e) => e === 'agent_permission_resolved')).toHaveLength(1);
    const subagent = {
      id: 'fake-tool', parentAgentId: 'claude1', provider: 'claude', title: 'Explore',
      status: 'running', createdAt: '2026-09-27T01:00:00Z', updatedAt: '2026-09-27T01:00:00Z',
    };
    daemon.emit('agent.provider_subagents.update', { kind: 'upsert', subagent });
    expect((await adapter.listConversations()).some((c) => c.id === 'claude1:fake-tool')).toBe(true);
    daemon.emit('agent.provider_subagents.update', { kind: 'remove', parentAgentId: 'claude1', subagentId: 'fake-tool' });
    expect((await adapter.listConversations()).some((c) => c.id === 'claude1:fake-tool')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'conversation_removed', id: 'claude1:fake-tool' });
    adapter.stop();
    await expect.poll(() => daemon.observed.length).toBe(0);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    expect(subscribed().filter((e) => e === 'agent_permission_resolved')).toHaveLength(1);
    daemon.emit('agent_permission_resolved', { agentId: 'a1', requestId: shellRequest.id });
    expect(adapter.listApprovals().some((a) => a.id === shellRequest.id)).toBe(false);
    adapter.stop();
  });

  it('rejects a failed initial timeline subscription and establishes a fresh one on the next open', async () => {
    const { adapter, daemon } = await setup();
    daemon.state.timelineFailure = 'fake subscription refused';
    await expect(adapter.getConversation('a1')).rejects.toThrow('fake subscription refused');
    expect(daemon.loads).toEqual([]);
    expect(daemon.timelineReleases).toEqual(['a1']);
    daemon.state.timelineFailure = null;
    await adapter.getConversation('a1');
    expect(daemon.timelineSubscriptions).toEqual(['a1', 'a1']);
    daemon.emit('agent_stream', live(1, { type: 'assistant_message', text: 'Recovered' }));
    expect((await adapter.getConversation('a1')).items).toEqual([expect.objectContaining({ text: 'Recovered' })]);
    adapter.stop();
  });

  it('invalidates a loaded mirror after timeline restoration fails on reconnect', async () => {
    const { adapter, daemon } = await setup();
    await adapter.getConversation('a1');
    daemon.reconnect();
    await new Promise((resolve) => setImmediate(resolve));
    daemon.failTimeline('a1', 'fake restore refused');
    expect(daemon.timelineReleases).toEqual(['a1']);
    await adapter.getConversation('a1');
    expect(daemon.timelineSubscriptions).toEqual(['a1', 'a1']);
    daemon.emit('agent_stream', live(1, { type: 'assistant_message', text: 'Live again' }));
    expect((await adapter.getConversation('a1')).items).toEqual([expect.objectContaining({ text: 'Live again' })]);
    adapter.stop();
  });

  it('keeps a late page from reviving a failed mirror or dropping its replacement', async () => {
    const { adapter, daemon } = await setup();
    let resolvePage!: (value: ReturnType<typeof page>) => void;
    vi.spyOn(daemon.client, 'fetchAgentTimeline').mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    const oldOpen = adapter.getConversation('a1');
    const rejected = expect(oldOpen).rejects.toThrow('fake lost subscription');
    await expect.poll(() => daemon.timelineSubscriptions.length).toBe(1);
    daemon.failTimeline('a1', 'fake lost subscription');
    await adapter.getConversation('a1');
    resolvePage(page('e1', [{ seq: 1, item: { type: 'assistant_message', text: 'Stale page' } }]));
    await rejected;
    expect(daemon.timelineReleases).toEqual(['a1']);
    expect((await adapter.getConversation('a1')).items).toEqual([]);
    expect(daemon.timelineSubscriptions).toEqual(['a1', 'a1']);
    daemon.emit('agent_stream', live(1, { type: 'assistant_message', text: 'Current subscription' }));
    expect((await adapter.getConversation('a1')).items).toEqual([expect.objectContaining({ text: 'Current subscription' })]);
    adapter.stop();
    expect(daemon.timelineReleases).toEqual(['a1', 'a1']);
  });
});

describe.each(['shadow', 'primary'] as const)('%s real Paseo authenticated actions', (role) => {
  it('forwards sends, create, approval, interrupt, archive, restore, delete and mkdir to the daemon', async () => {
    const { adapter, daemon } = await setup([], new BackgroundGate(role));
    const keys = await makeKeys();
    const token = await makeToken(keys);
    const config = { ...makeConfig(), role };
    const app = await buildApp({ config, sources: { hermes: new FakeHermes(), paseo: adapter }, hub: new EventHub(), logger: false,
      verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }) });
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: postHeaders(token) });
    try {
      expect((await post('/api/conversations/paseo/a1/messages', { text: 'Demo request' })).statusCode).toBe(200);
      expect((await post('/api/conversations/paseo/a1/approvals/perm-1', { optionId: 'allow_once' })).statusCode).toBe(200);
      daemon.emit('agent_update', { agent: daemon.agent('a1', [], { status: 'running' }) });
      expect((await post('/api/conversations/paseo/a1/interrupt', {})).statusCode).toBe(200);
      expect((await post('/api/paseo/conversations', { providerId: 'claude', cwd: '/home/me/code/app', text: 'Demo chat' })).statusCode).toBe(200);
      for (const action of ['archive', 'restore', 'delete']) {
        expect((await post(`/api/threads/${action}`, { threads: [{ source: 'paseo', id: 'a1' }] })).json()).toEqual({ done: 1, failed: [] });
      }
      expect((await post('/api/folders', { path: '/home/me/code/demo' })).statusCode).toBe(200);
      expect(daemon.sent.some((s) => s.agentId === 'a1' && s.text === 'Demo request')).toBe(true);
      expect(daemon.created).toHaveLength(1);
      expect(daemon.responses).toContainEqual(expect.objectContaining({ agentId: 'a1', requestId: 'perm-1' }));
      expect(daemon.actions).toEqual([['interrupt', 'a1'], ['archive', 'a1'], ['restore', 'a1'], ['delete', 'a1']]);
      expect(daemon.folderCreates).toContainEqual({ parentPath: '/home/me/code', name: 'demo' });
    } finally { adapter.stop(); await app.close(); }
  });
});

describe('paseo adapter folders', () => {
  it('says whether a folder exists, the way the daemon sees it', async () => {
    const { adapter } = await setup();
    expect(await adapter.folderStatus('/home/me/code/app')).toBe('exists');
    expect(await adapter.folderStatus('/home/me/code/app/')).toBe('exists');
    expect(await adapter.folderStatus('/')).toBe('exists');
    expect(await adapter.folderStatus('/home/me/notes')).toBe('missing');
    expect(await adapter.folderStatus('/home/me/nope/deeper')).toBe('missing-parent');
    expect(await adapter.folderStatus('/home/me/notes.txt')).toBe('not-a-folder');
    expect(await adapter.folderStatus('/home/me/notes.txt/x')).toBe('missing-parent');
    await expect(adapter.folderStatus('code/app')).rejects.toMatchObject({ status: 400 });
  });

  it("doesn't guess when the daemon can't say", async () => {
    const { adapter, daemon } = await setup();
    daemon.client.listDirectory = async () => {
      throw new Error('EACCES: permission denied, scandir');
    };
    expect(await adapter.folderStatus('/root/secret')).toBe('unknown');
  });

  it('makes a new folder one level below an existing one, through Paseo', async () => {
    const { adapter, daemon } = await setup();
    expect(await adapter.createFolder('/home/me/notes/')).toBe('/home/me/notes');
    expect(daemon.folderCreates).toEqual([{ parentPath: '/home/me', name: 'notes' }]);
    expect(await adapter.folderStatus('/home/me/notes')).toBe('exists');
    // Made in the meantime: that's the folder wanted.
    expect(await adapter.createFolder('/home/me/code/app')).toBe('/home/me/code/app');
    await expect(adapter.createFolder('/home/me/nope/deeper')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('Parent directory not found'),
    });
    await expect(adapter.createFolder('notes')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.createFolder('/home/me/bad\u0007name')).rejects.toMatchObject({ status: 400 });
  });
});

describe('paseo adapter approvals', () => {
  it('lists agents with waiting approvals first-class', async () => {
    const { adapter } = await setup();
    const list = await adapter.listConversations();
    expect(list.map((c) => [c.id, c.status, c.pendingApprovals])).toEqual([
      ['a1', 'needs_approval', 1],
      ['a2', 'needs_approval', 2],
    ]);
    expect(list[0]).toMatchObject({
      subtitle: 'Hermes in Paseo · ~/code/app',
      hermesInPaseo: true,
      agentLabel: 'Hermes',
      project: { path: '/home/me/code/app', name: 'app' },
    });
  });

  it('refuses answers for the wrong agent or with options that were not offered', async () => {
    const { adapter, daemon } = await setup();
    await expect(adapter.respondToApproval('a2', 'perm-1', { optionId: 'allow_once' })).rejects.toBeInstanceOf(UserFacingError);
    await expect(adapter.respondToApproval('a1', 'perm-1', { optionId: 'allow' })).rejects.toBeInstanceOf(UserFacingError);
    await expect(adapter.respondToApproval('a1', 'perm-404', { optionId: 'deny' })).rejects.toBeInstanceOf(UserFacingError);
    expect(daemon.responses).toEqual([]);

    await adapter.respondToApproval('a1', 'perm-1', { optionId: 'deny' });
    expect(daemon.responses).toEqual([
      { agentId: 'a1', requestId: 'perm-1', response: { behavior: 'deny', selectedActionId: 'deny' } },
    ]);
    expect(adapter.listApprovals().some((a) => a.id === 'perm-1')).toBe(false);
  });

  it('collects every answer before replying to a multi-question request', async () => {
    const { adapter, daemon } = await setup();
    await adapter.respondToApproval('a2', 'perm-q.q0', { optionId: '0' });
    expect(daemon.responses).toEqual([]);
    await adapter.respondToApproval('a2', 'perm-q.q1', { optionIds: ['1'] });
    expect(daemon.responses).toEqual([
      {
        agentId: 'a2',
        requestId: 'perm-q',
        response: {
          behavior: 'allow',
          updatedInput: { ...(questionRequest.input as object), answers: { DB: 'Postgres', Extras: 'Billing' } },
        },
      },
    ]);
  });

  it('keeps the last question card if sending the answers fails', async () => {
    const { adapter, daemon } = await setup();
    await adapter.respondToApproval('a2', 'perm-q.q0', { optionId: '0' });
    daemon.state.failResponses = true;
    await expect(adapter.respondToApproval('a2', 'perm-q.q1', { optionIds: ['1'] })).rejects.toBeInstanceOf(UserFacingError);
    expect(adapter.listApprovals().map((a) => a.id)).toContain('perm-q.q1');
    daemon.state.failResponses = false;
    await adapter.respondToApproval('a2', 'perm-q.q1', { optionIds: ['1'] });
    expect(daemon.responses.at(-1)).toMatchObject({ requestId: 'perm-q' });
    expect(adapter.listApprovals().some((a) => a.id.startsWith('perm-q'))).toBe(false);
  });

  it('offers only non-blocked modes and marks the ones that act without asking', async () => {
    const { adapter } = await setup();
    const { providers, workspaces } = await adapter.options();
    const claude = providers.find((p) => p.id === 'claude')!;
    expect(claude.modes.map((m) => [m.id, Boolean(m.autoApproves)])).toEqual([
      ['plan', false], ['default', false], ['acceptEdits', true], ['auto', true],
    ]);
    expect(claude.defaultModeId).toBe('default');
    expect(providers.find((p) => p.id === 'pi')).toMatchObject({ autoApproves: true, modes: [] });
    expect(providers.some((p) => p.id === 'codex')).toBe(false);
    expect(workspaces).toEqual([{ path: '/home/me/code/app', label: 'app' }]);
  });

  it('launches agents only in vetted modes, with explicit consent when they act on their own', async () => {
    const { adapter, daemon } = await setup();
    await adapter.options();
    const base = { providerId: 'claude', cwd: '/home/me/code/app', text: 'fix it' };

    await expect(adapter.createConversation({ ...base, modeId: 'bypassPermissions', acknowledgeAutoApprove: true })).rejects.toThrow(/safeguard/);
    await expect(adapter.createConversation({ ...base, modeId: 'nonexistent' })).rejects.toBeInstanceOf(UserFacingError);
    await expect(adapter.createConversation({ ...base, modeId: 'acceptEdits' })).rejects.toThrow(/Confirm/);
    await expect(adapter.createConversation({ providerId: 'pi', cwd: '/home/me/code/app', text: 'hi' })).rejects.toThrow(/Confirm/);
    await expect(adapter.createConversation({ ...base, providerId: 'codex' })).rejects.toBeInstanceOf(UserFacingError);
    expect(daemon.created).toEqual([]);

    await adapter.createConversation(base);
    expect(daemon.created.at(-1)).toMatchObject({ provider: 'claude', modeId: 'default', workspaceId: 'ws1', initialPrompt: 'fix it' });
    await adapter.createConversation({ ...base, modeId: 'acceptEdits', acknowledgeAutoApprove: true });
    expect(daemon.created.at(-1)).toMatchObject({ modeId: 'acceptEdits' });
    await adapter.createConversation({ providerId: 'pi', cwd: '/home/me/code/app', text: 'hi', acknowledgeAutoApprove: true });
    expect(daemon.created.at(-1)).not.toHaveProperty('modeId');
    expect(daemon.created.at(-1)).not.toHaveProperty('featureValues');
  });

  it('tracks permission requests and resolutions from the daemon', async () => {
    const { adapter, daemon, events } = await setup();
    daemon.emit('agent_permission_resolved', { agentId: 'a1', requestId: 'perm-1', resolution: { behavior: 'allow' } });
    expect(adapter.listApprovals().some((a) => a.id === 'perm-1')).toBe(false);
    expect(events.some((e) => e.type === 'approval_removed' && e.approvalId === 'perm-1')).toBe(true);
  });

  it('derives both worker snapshots from live permission requests and resolutions', async () => {
    const { adapter, daemon } = await setup([{ id: 'demo-worker', status: 'running' }]);
    const count = (id: string) => [adapter.workerSnapshot(id)!.pendingPermissions,
      adapter.workerSnapshots().find((snap) => snap.id === id)!.pendingPermissions];
    expect(count('demo-worker')).toEqual([0, 0]);
    daemon.emit('agent_permission_request', { agentId: 'demo-worker', request: { ...shellRequest, id: 'perm-demo-live' } });
    expect(adapter.listApprovals().some((a) => a.conversationId === 'demo-worker')).toBe(true);
    expect(count('demo-worker')).toEqual([1, 1]);
    daemon.emit('agent_permission_resolved', { agentId: 'a1', requestId: 'perm-1', resolution: { behavior: 'allow' } });
    expect(adapter.listApprovals().some((a) => a.conversationId === 'a1')).toBe(false);
    expect(count('a1')).toEqual([0, 0]);
    daemon.emit('agent_permission_resolved', { agentId: 'demo-worker', requestId: 'perm-demo-live', resolution: { behavior: 'allow' } });
    expect(count('demo-worker')).toEqual([0, 0]);
    await adapter.stop();
  });
});

describe('paseo adapter: files and "/" commands', () => {
  afterEach(() => vi.restoreAllMocks());

  const userEcho = (agentId: string, seq: number, text: string, clientMessageId?: string) => ({
    agentId,
    event: {
      type: 'timeline',
      provider: 'hermes',
      item: { type: 'user_message', text, ...(clientMessageId ? { clientMessageId } : {}) },
      turnId: 't1',
    },
    timestamp: '2026-09-27T00:00:01Z',
    seq,
    epoch: 'e1',
  });

  it('sends images and small text files inline, and PDFs through a Paseo upload', async () => {
    const { adapter, daemon } = await setup([{ id: 'idle1', status: 'idle' }]);
    await adapter.sendMessage('idle1', 'What changed?', [image, notes, spec]);

    expect(daemon.uploads).toEqual([{ fileName: 'spec.pdf', mimeType: 'application/pdf', bytes: PDF }]);
    expect(daemon.sent).toEqual([
      {
        agentId: 'idle1',
        text: 'What changed?',
        options: {
          messageId: expect.any(String),
          images: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
          attachments: [
            { type: 'text', mimeType: 'text/plain', title: 'notes.md', text: 'Attached file: notes.md\n\n# hi' },
            {
              type: 'uploaded_file',
              id: 'upload_1',
              fileName: 'spec.pdf',
              mimeType: 'application/pdf',
              size: PDF.length,
              path: '/home/me/.paseo/uploads/upload_1/spec.pdf',
            },
          ],
        },
      },
    ]);
    // Plain text stays plain: no empty file lists.
    await adapter.sendMessage('idle1', 'thanks');
    expect(Object.keys(daemon.sent[1]!.options)).toEqual(['messageId']);
    expect(daemon.sent[1]!.options.messageId).not.toBe(daemon.sent[0]!.options.messageId);
  });

  it('uploads Office documents and archives for the agent to open by path', async () => {
    const { adapter, daemon } = await setup([{ id: 'idle1', status: 'idle' }]);
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const sheet: Attachment = { name: 'budget.xlsx', mimeType: XLSX, kind: 'file', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0]) };
    await adapter.sendMessage('idle1', 'Sum column B', [sheet]);
    expect(daemon.uploads).toEqual([{ fileName: 'budget.xlsx', mimeType: XLSX, bytes: sheet.bytes }]);
    expect(daemon.sent[0]).toMatchObject({
      text: 'Sum column B',
      options: {
        attachments: [{ type: 'uploaded_file', fileName: 'budget.xlsx', path: '/home/me/.paseo/uploads/upload_1/budget.xlsx' }],
      },
    });
  });

  it('uploads big text files, and sends nothing when an upload fails', async () => {
    const { adapter, daemon } = await setup([{ id: 'idle1', status: 'idle' }]);
    const log: Attachment = { name: 'app.log', mimeType: 'text/plain', kind: 'text', bytes: Buffer.alloc(200 * 1024, 'a') };
    await adapter.sendMessage('idle1', '', [log]);
    expect(daemon.sent[0]).toMatchObject({ text: '', options: { attachments: [{ type: 'uploaded_file', fileName: 'app.log' }] } });

    daemon.state.failUpload = true;
    const failed = adapter.sendMessage('idle1', 'read this', [image, spec]);
    await expect(failed).rejects.toBeInstanceOf(UserFacingError);
    await expect(failed).rejects.toThrow("Paseo couldn't take spec.pdf: disk full");
    expect(daemon.sent).toHaveLength(1);
  });

  it('steers a running agent, like the Paseo app, and starts a turn on an idle one', async () => {
    const { adapter, daemon } = await setup([{ id: 'idle1', status: 'idle' }]);
    await adapter.sendMessage('a1', 'also run the tests');
    expect(daemon.sent.at(-1)!.options).toMatchObject({ activeTurnBehavior: 'steer' });
    await adapter.sendMessage('idle1', 'hi');
    expect(daemon.sent.at(-1)!.options).not.toHaveProperty('activeTurnBehavior');
  });

  it("shows the files on the user's message, which Paseo stores as text only", async () => {
    const { adapter, daemon, itemsOf, open } = await setup([{ id: 'idle1', status: 'idle' }]);
    open('idle1');
    await adapter.getConversation('idle1');
    await adapter.sendMessage('idle1', 'look', [image, spec]);
    await adapter.sendMessage('idle1', '', [image]);
    const [first, second] = daemon.sent.map((s) => s.options.messageId);

    daemon.emit('agent_stream', userEcho('idle1', 1, 'look', first));
    daemon.emit('agent_stream', userEcho('idle1', 2, '', second));
    daemon.emit('agent_stream', userEcho('idle1', 3, '', 'sent-elsewhere'));
    expect(itemsOf('idle1')).toEqual([
      { kind: 'user', id: 's-e1-1', text: 'look', attachments: [{ name: 'shot.png', kind: 'image' }, { name: 'spec.pdf', kind: 'pdf' }] },
      { kind: 'user', id: 's-e1-2', text: '', attachments: [{ name: 'shot.png', kind: 'image' }] },
    ]);
    expect(JSON.stringify(itemsOf('idle1'))).not.toContain(PNG.toString('base64'));

    // A send that failed isn't remembered.
    daemon.state.failSend = true;
    await expect(adapter.sendMessage('idle1', 'again', [image])).rejects.toBeInstanceOf(UserFacingError);
    daemon.emit('agent_stream', userEcho('idle1', 4, 'again', daemon.sent.at(-1)!.options.messageId));
    expect(itemsOf('idle1').at(-1)).toEqual({ kind: 'user', id: 's-e1-4', text: 'again' });
  });

  it('launches an agent with files and no text', async () => {
    const { adapter, daemon } = await setup();
    await adapter.options();
    await adapter.createConversation({ providerId: 'claude', cwd: '/home/me/code/app', text: '', attachments: [image, spec] });
    const launch = daemon.created.at(-1)!;
    expect(launch).toMatchObject({
      initialPrompt: '',
      clientMessageId: expect.any(String),
      images: [{ data: PNG.toString('base64'), mimeType: 'image/png' }],
      attachments: [{ type: 'uploaded_file', fileName: 'spec.pdf' }],
    });

    daemon.state.timeline = page('e1', [{ seq: 1, item: { type: 'user_message', text: '', clientMessageId: launch.clientMessageId } }]);
    const detail = await adapter.getConversation('new-agent');
    expect(detail.items).toEqual([
      { kind: 'user', id: 's-e1-1', text: '', attachments: [{ name: 'shot.png', kind: 'image' }, { name: 'spec.pdf', kind: 'pdf' }] },
    ]);

    // Refused launches upload nothing.
    const uploads = daemon.uploads.length;
    const refused = { providerId: 'claude', cwd: '/home/me/code/app', text: '', modeId: 'bypassPermissions', attachments: [spec] };
    await expect(adapter.createConversation(refused)).rejects.toThrow(/safeguard/);
    expect(daemon.uploads).toHaveLength(uploads);
  });

  it("lists the agent's own commands, cached, without waking agents Paseo has only stored", async () => {
    const { adapter, daemon } = await setup([
      { id: 'stored', status: 'idle', capabilities: { supportsStreaming: false } },
      { id: 'closed', status: 'closed' },
    ]);
    const expected = [
      { name: 'review', kind: 'command', description: 'Review the changes', args: '[focus]' },
      { name: 'tdd', kind: 'skill', description: 'Test first' },
    ];
    expect(await adapter.listCommands('a1')).toEqual(expected);
    expect(await adapter.listCommands('a1')).toEqual(expected);
    expect(daemon.commandCalls).toEqual(['a1']);

    // Asking would make Paseo resume these, so they get none.
    for (const id of ['stored', 'closed', 'unknown']) expect(await adapter.listCommands(id)).toEqual([]);
    expect(daemon.commandCalls).toEqual(['a1']);

    // Opening the conversation loads the agent in Paseo; then its commands are listed.
    daemon.state.liveAgent = daemon.agent('stored', [], { status: 'idle' });
    await adapter.getConversation('stored');
    expect(await adapter.listCommands('stored')).toEqual(expected);
    expect(daemon.commandCalls).toEqual(['a1', 'stored']);

    // The cache expires.
    const later = Date.now() + 6 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await adapter.listCommands('a1');
    expect(daemon.commandCalls).toEqual(['a1', 'stored', 'a1']);
  });

  it('shows no commands when Paseo reports an error, and keeps asking while the list is empty', async () => {
    const { adapter, daemon } = await setup();
    daemon.state.commandsError = 'Agent does not support listing commands';
    expect(await adapter.listCommands('a1')).toEqual([]);
    daemon.state.commandsError = null;
    daemon.state.commands = [];
    expect(await adapter.listCommands('a1')).toEqual([]);
    expect(await adapter.listCommands('a1')).toEqual([]);
    expect(daemon.commandCalls).toEqual(['a1', 'a1', 'a1']);

    daemon.state.commandsThrow = true;
    await expect(adapter.listCommands('a2')).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe('paseo adapter: model, reasoning and mode', () => {
  const hermesAgent = claudeAgent({
    id: 'h1',
    provider: 'hermes',
    status: 'running',
    runtimeInfo: { provider: 'hermes', sessionId: 's2', model: 'gpt' },
    availableModes: HERMES_MODES,
  });
  const storedAgent = claudeAgent({
    id: 'stored',
    capabilities: { supportsStreaming: false },
    availableModes: [],
    currentModeId: 'plan',
    runtimeInfo: undefined,
    model: 'claude-sonnet',
  });
  const reject = (promise: Promise<unknown>, status: number, text: RegExp) =>
    expect(promise).rejects.toSatisfy((err: unknown) => err instanceof UserFacingError && err.status === status && text.test(err.message));

  it("offers what Paseo lists for the agent's folder, from a cached snapshot", async () => {
    const { adapter, daemon } = await setup([claudeAgent({ lastUsage: { contextWindowUsedTokens: 50_000 } })]);
    const first = await adapter.getControls('claude1');
    expect(first.controls.map((c) => [c.id, c.value])).toEqual([['model', 'claude-sonnet'], ['reasoning', 'low'], ['mode', 'default']]);
    expect(first.context).toEqual({ used: 50_000, max: 200_000 });
    await adapter.getControls('claude1');
    expect(daemon.snapshotCwds.filter(Boolean)).toEqual(['/home/me/code/app']);
    expect(await adapter.getControls('nope')).toEqual({ controls: [] });
  });

  it('changes settings only to offered options, and asks before modes that act on their own', async () => {
    const { adapter, daemon } = await setup([claudeAgent()]);
    await reject(adapter.setControl('claude1', { control: 'mode', value: 'bypassPermissions', acknowledgeAutoApprove: true }), 400, /offered/);
    await reject(adapter.setControl('claude1', { control: 'model', value: 'claude-internal' }), 400, /offered/);
    await reject(adapter.setControl('claude1', { control: 'reasoning', value: 'plan' }), 400, /offered/);
    await reject(adapter.setControl('claude1', { control: 'mode', value: 'acceptEdits' }), 400, /without asking you first/);
    expect(daemon.configCalls).toEqual([]);

    daemon.state.notice = { type: 'info', message: 'Edits are accepted without asking.' };
    const mode = await adapter.setControl('claude1', { control: 'mode', value: 'acceptEdits', acknowledgeAutoApprove: true });
    expect(mode).toMatchObject({ ok: true, notice: 'Edits are accepted without asking.' });
    expect(mode.ok && mode.controls.controls.find((c) => c.id === 'mode')).toMatchObject({ value: 'acceptEdits' });

    daemon.state.notice = null;
    const model = await adapter.setControl('claude1', { control: 'model', value: 'claude-opus' });
    expect(model).not.toHaveProperty('notice');
    expect(model.ok && model.controls.controls.map((c) => [c.id, c.value])).toEqual([['model', 'claude-opus'], ['mode', 'acceptEdits']]);
    await adapter.setControl('claude1', { control: 'mode', value: 'plan' }); // back to asking: no OK needed
    expect(daemon.configCalls).toEqual([
      ['mode', 'claude1', 'acceptEdits'],
      ['model', 'claude1', 'claude-opus'],
      ['mode', 'claude1', 'plan'],
    ]);
  });

  it('sets the thinking level of the current model, and never touches agent features', async () => {
    const { adapter, daemon } = await setup([claudeAgent()]);
    const res = await adapter.setControl('claude1', { control: 'reasoning', value: 'xhigh' });
    const reasoning = res.ok ? res.controls.controls.find((c) => c.id === 'reasoning') : undefined;
    expect(reasoning).toMatchObject({ value: 'xhigh' });
    expect(reasoning).not.toHaveProperty('valueLabel');
    expect(daemon.configCalls).toEqual([['reasoning', 'claude1', 'xhigh']]);
    expect(daemon.configCalls.some(([kind]) => kind === 'feature')).toBe(false);
  });

  it('lets Hermes-in-Paseo switch models only between turns', async () => {
    const { adapter, daemon } = await setup([hermesAgent]);
    const { controls } = await adapter.getControls('h1');
    expect(controls.find((c) => c.id === 'model')).toMatchObject({ value: 'gpt', disabledReason: HERMES_BUSY_MODEL });
    await reject(adapter.setControl('h1', { control: 'model', value: 'kimi' }), 409, /between turns/);
    await reject(adapter.setControl('h1', { control: 'mode', value: 'dont_ask', acknowledgeAutoApprove: true }), 400, /offered/);
    await adapter.setControl('h1', { control: 'mode', value: 'default' }); // modes may change mid-turn
    expect(daemon.configCalls).toEqual([['mode', 'h1', 'default']]);
  });

  it('reads a stored agent from snapshots without waking it; changing a setting may', async () => {
    const { adapter, daemon } = await setup([storedAgent]);
    const { controls } = await adapter.getControls('stored');
    expect(controls.map((c) => [c.id, c.value])).toEqual([['model', 'claude-sonnet'], ['reasoning', 'low'], ['mode', 'plan']]);
    expect(daemon.loads).toEqual([]);
    expect(daemon.commandCalls).toEqual([]);

    await adapter.setControl('stored', { control: 'mode', value: 'default' });
    expect(daemon.configCalls).toEqual([['mode', 'stored', 'default']]);
  });

  it('waits while Paseo is still asking the agent CLI, and keeps nothing when it gets no answer', async () => {
    const { adapter, daemon } = await setup([claudeAgent(), claudeAgent({ id: 'claude2', cwd: '/home/me/code/other' })]);
    daemon.state.claudeStatus = 'loading';
    const pending = adapter.getControls('claude1');
    await expect.poll(() => daemon.snapshotCwds.includes('/home/me/code/app')).toBe(true);
    daemon.state.claudeStatus = 'ready';
    daemon.emit('providers_snapshot_update', { cwd: '/home/me/code/app', entries: daemon.providerEntries() });
    expect((await pending).controls.map((c) => c.id)).toEqual(['model', 'reasoning', 'mode']);

    // An older daemon can't be waited on: no model picker yet, and nothing is cached.
    daemon.state.waitable = false;
    daemon.state.claudeStatus = 'loading';
    expect((await adapter.getControls('claude2')).controls.map((c) => c.id)).toEqual(['mode']);
    daemon.state.claudeStatus = 'ready';
    expect((await adapter.getControls('claude2')).controls.map((c) => c.id)).toEqual(['model', 'reasoning', 'mode']);
  });
});

describe('paseo adapter: images an agent showed', () => {
  const refused = (promise: Promise<unknown>, status: number, text: string) =>
    expect(promise).rejects.toSatisfy((err: unknown) => err instanceof UserFacingError && err.status === status && err.message === text);

  it("has Paseo read them against home, the agent's folder or the root, never more than the size cap", async () => {
    const { adapter, daemon } = await setup();
    const image = await adapter.readImage('a1', '~/Pictures/cat.png');
    expect(Buffer.isBuffer(image.bytes) && image.bytes.equals(PNG)).toBe(true);
    await adapter.readImage('a1', '/home/me/code/app/shots/ui.png');
    await adapter.readImage('a1', '/tmp/paseo-attachments-1/abc.png');
    expect(daemon.reads).toEqual([
      { cwd: '~', path: '~/Pictures/cat.png', maxBytes: MAX_MEDIA_BYTES },
      { cwd: '/home/me/code/app', path: '/home/me/code/app/shots/ui.png', maxBytes: MAX_MEDIA_BYTES },
      { cwd: '/', path: '/tmp/paseo-attachments-1/abc.png', maxBytes: MAX_MEDIA_BYTES },
    ]);
    // A file-explorer read: nothing that would make Paseo load an agent.
    expect(daemon.loads).toEqual([]);
    await refused(adapter.readImage('gone', '/tmp/a.png'), 404, 'That Paseo agent no longer exists.');
  });

  it("refuses files that aren't images, and passes on why Paseo refused, without retrying elsewhere", async () => {
    const { adapter, daemon } = await setup();
    daemon.state.readKind = 'text';
    await refused(adapter.readImage('a1', '/home/me/code/app/notes.png'), 415, "That file isn't an image Wayroost can show.");
    daemon.state.readKind = 'image';

    const cases: Array<[string, number, string]> = [
      ['Access outside of workspace is not allowed', 403, 'Access outside of workspace is not allowed'],
      ["ENOENT: no such file or directory, open '/tmp/x.png'", 404, "ENOENT: no such file or directory, open '/tmp/x.png'"],
      ['File is too large to display', 413, 'File is too large to display'],
      ['Requested path is not a file', 502, 'Paseo: Requested path is not a file'],
    ];
    for (const [error, status, text] of cases) {
      daemon.state.readError = error;
      const before = daemon.reads.length;
      await refused(adapter.readImage('a1', '/home/me/code/app/link.png'), status, text);
      expect(daemon.reads.length - before).toBe(1);
    }
  });
});

describe('paseo adapter: when an agent was last active', () => {
  afterEach(() => vi.restoreAllMocks());
  const at = (iso: string) => Date.parse(iso);
  const summaryTime = async (adapter: PaseoAdapter, id: string) => (await adapter.listConversations()).find((c) => c.id === id)!.updatedAt;
  const USER = '2026-09-27T01:00:00Z';

  it('falls back from the last user message to when the agent was created, then to updatedAt', () => {
    expect(lastActivity({ lastUserMessageAt: USER, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-27T09:00:00Z' })).toBe(at(USER));
    expect(lastActivity({ lastUserMessageAt: null, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-27T09:00:00Z' })).toBe(at('2026-09-20T00:00:00Z'));
    expect(lastActivity({ lastUserMessageAt: null, createdAt: 'garbage', updatedAt: '2026-09-27T09:00:00Z' })).toBe(at('2026-09-27T09:00:00Z'));
    expect(lastActivity({ lastUserMessageAt: USER, createdAt: USER, updatedAt: USER }, at('2026-09-27T05:00:00Z'))).toBe(at('2026-09-27T05:00:00Z'));
  });

  it("keeps an idle agent's time when Paseo merely reloads or resumes it", async () => {
    const { adapter, daemon } = await setup([
      { id: 'm1', status: 'idle', lastUserMessageAt: USER, updatedAt: USER },
      { id: 'stale', status: 'running', capabilities: { supportsStreaming: false }, lastUserMessageAt: USER, updatedAt: USER },
    ]);
    expect(await summaryTime(adapter, 'm1')).toBe(at(USER));
    // A daemon restart, a timeline fetch, a bridge read: updatedAt moves, the agent doesn't run.
    const reload = (id: string, status: string, updatedAt: string) =>
      daemon.emit('agent_update', { kind: 'upsert', agent: daemon.agent(id, [], { status, lastUserMessageAt: USER, updatedAt }) });
    reload('m1', 'closed', '2026-09-27T08:00:00Z');
    reload('m1', 'initializing', '2026-09-27T08:00:01Z');
    reload('m1', 'idle', '2026-09-27T08:00:02Z');
    expect(await summaryTime(adapter, 'm1')).toBe(at(USER));
    // Paseo only had this one stored, with the status it was saved in; loading it isn't a run ending.
    reload('stale', 'idle', '2026-09-27T08:00:03Z');
    expect(await summaryTime(adapter, 'stale')).toBe(at(USER));
  });

  it('moves when a run starts and when it finishes, and holds still while it runs', async () => {
    const { adapter, daemon, events } = await setup([{ id: 'm1', status: 'idle', lastUserMessageAt: USER, updatedAt: USER }]);
    const update = (status: string, updatedAt: string) =>
      daemon.emit('agent_update', { kind: 'upsert', agent: daemon.agent('m1', [], { status, lastUserMessageAt: USER, updatedAt }) });
    const upserts = () => events.filter((e) => e.type === 'conversation_upsert' && e.conversation.id === 'm1').length;

    vi.spyOn(Date, 'now').mockReturnValue(at('2026-09-27T09:00:00Z'));
    update('running', '2026-09-27T09:00:00Z');
    expect(await summaryTime(adapter, 'm1')).toBe(at('2026-09-27T09:00:00Z'));
    const published = upserts();
    vi.spyOn(Date, 'now').mockReturnValue(at('2026-09-27T09:05:00Z'));
    update('running', '2026-09-27T09:05:00Z');
    expect(await summaryTime(adapter, 'm1')).toBe(at('2026-09-27T09:00:00Z'));
    expect(upserts()).toBe(published); // same summary: not sent again

    vi.spyOn(Date, 'now').mockReturnValue(at('2026-09-27T09:30:00Z'));
    update('idle', '2026-09-27T09:30:00Z');
    expect(await summaryTime(adapter, 'm1')).toBe(at('2026-09-27T09:30:00Z'));
  });

  it('moves with a new user message, including one the bridge delivered', async () => {
    const { adapter, daemon } = await setup([{ id: 'm1', status: 'idle', lastUserMessageAt: USER, updatedAt: USER }]);
    daemon.emit('agent_update', {
      kind: 'upsert',
      agent: daemon.agent('m1', [], { status: 'idle', lastUserMessageAt: '2026-09-27T10:00:00Z', updatedAt: '2026-09-27T10:00:00Z' }),
    });
    expect(await summaryTime(adapter, 'm1')).toBe(at('2026-09-27T10:00:00Z'));
  });

  it('orders agents by real activity after a start, not by when Paseo last touched them', async () => {
    const { adapter } = await setup([
      { id: 'reloaded', status: 'idle', lastUserMessageAt: USER, updatedAt: '2026-09-27T09:00:00Z' },
      { id: 'recent', status: 'idle', lastUserMessageAt: '2026-09-27T06:00:00Z', updatedAt: '2026-09-27T06:30:00Z' },
      { id: 'new', status: 'idle', lastUserMessageAt: null, createdAt: '2026-09-27T05:00:00Z', updatedAt: '2026-09-27T09:30:00Z' },
    ]);
    const mine = (await adapter.listConversations()).filter((c) => ['reloaded', 'recent', 'new'].includes(c.id));
    expect(mine.sort((a, b) => b.updatedAt - a.updatedAt).map((c) => c.id)).toEqual(['recent', 'new', 'reloaded']);
  });
});

describe('paseo adapter: provider sub-agents', () => {
  /** A sub-agent as Paseo describes it: Claude Code's Task tool, started `minute` minutes past one. */
  const sub = (id: string, overrides: object = {}, minute = 0) => {
    const at = new Date(Date.parse('2026-09-27T01:00:00Z') + minute * 60_000).toISOString();
    return {
      id,
      parentAgentId: 'claude1',
      provider: 'claude',
      title: 'Explore',
      description: 'Find where sessions are set up',
      status: 'running',
      createdAt: at,
      updatedAt: at,
      toolCallId: id,
      ...overrides,
    };
  };
  const upsert = (daemon: ReturnType<typeof fakeDaemon>, subagent: object) =>
    daemon.emit('agent.provider_subagents.update', { kind: 'upsert', subagent });
  const rows = async (adapter: PaseoAdapter) => (await adapter.listConversations()).filter((c) => c.subagent);
  const refused = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy((err: unknown) => err instanceof UserFacingError && err.status === 400 && err.message === SUBAGENT_READ_ONLY);

  it('lists them as read-only rows under the agent that runs them, in its project', async () => {
    const { adapter, daemon, events } = await setup([claudeAgent()]);
    upsert(daemon, sub('toolu_1'));
    expect(await rows(adapter)).toEqual([
      {
        source: 'paseo',
        id: 'claude1:toolu_1',
        title: 'Explore',
        subtitle: 'Sub-agent · ~/code/app · Claude Code',
        preview: 'Find where sessions are set up',
        status: 'running',
        updatedAt: Date.parse('2026-09-27T01:00:00Z'),
        pendingApprovals: 0,
        project: { path: '/home/me/code/app', name: 'app' },
        agentLabel: 'Claude Code',
        parent: { source: 'paseo', id: 'claude1' },
        subagent: true,
      },
    ]);
    expect(events.some((e) => e.type === 'conversation_upsert' && e.conversation.id === 'claude1:toolu_1')).toBe(true);

    // How each status reads, and what a sub-agent without a title is called.
    const cases: Array<[object, string, string]> = [
      [{ status: 'failed' }, 'error', 'Explore'],
      [{ status: 'completed' }, 'idle', 'Explore'],
      [{ status: 'canceled' }, 'idle', 'Explore'],
      [{ title: null }, 'running', 'Find where sessions are set up'],
      [{ title: null, description: null }, 'running', 'Sub-agent'],
    ];
    for (const [overrides, status, title] of cases) {
      upsert(daemon, sub('toolu_1', overrides));
      expect((await rows(adapter)).map((r) => [r.status, r.title])).toEqual([[status, title]]);
    }
    expect((await rows(adapter))[0]).not.toHaveProperty('preview');

    // Its agent moving to another project takes it along.
    daemon.emit('agent_update', {
      kind: 'upsert',
      agent: daemon.agent('claude1', [], { ...claudeAgent(), cwd: '/home/me/code/app/packages/web' }),
      project: { projectName: 'App', checkout: { mainRepoRoot: '/home/me/code/app' } },
    });
    expect((await rows(adapter))[0]!.project).toEqual({ path: '/home/me/code/app', name: 'App' });
    const last = events.filter((e) => e.type === 'conversation_upsert' && e.conversation.id === 'claude1:toolu_1').at(-1);
    expect(last).toMatchObject({ conversation: { project: { name: 'App' } } });

    daemon.emit('agent.provider_subagents.update', { kind: 'remove', parentAgentId: 'claude1', subagentId: 'toolu_1' });
    expect(await rows(adapter)).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'conversation_removed', source: 'paseo', id: 'claude1:toolu_1' });
  });

  it("ignores what a sub-agent does, and sub-agents of agents it doesn't list or that aren't running", async () => {
    const { adapter, daemon } = await setup([claudeAgent(), claudeAgent({ id: 'stored', capabilities: { supportsStreaming: false } })]);
    daemon.emit('agent.provider_subagents.update', {
      kind: 'timeline',
      parentAgentId: 'claude1',
      subagentId: 'toolu_1',
      provider: 'claude',
      item: { type: 'assistant_message', text: 'secret findings' },
      timestamp: '2026-09-27T01:00:00Z',
      seq: 1,
      epoch: 'e1',
    });
    upsert(daemon, sub('toolu_2', { parentAgentId: 'not-listed' }));
    upsert(daemon, sub('toolu_3', { parentAgentId: 'stored' }));
    expect(await rows(adapter)).toEqual([]);
    expect(JSON.stringify(await adapter.listConversations())).not.toContain('secret findings');
  });

  it('keeps the newest 20 per agent and 200 in all', async () => {
    const { adapter, daemon, events } = await setup([claudeAgent()]);
    for (let i = 0; i < 25; i++) upsert(daemon, sub(`toolu_${i}`, {}, i));
    const kept = (await rows(adapter)).map((r) => r.id);
    expect(kept.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `claude1:toolu_${i + 5}`).sort());
    const removed = events.flatMap((e) => (e.type === 'conversation_removed' ? [e.id] : []));
    expect(removed).toEqual(['claude1:toolu_0', 'claude1:toolu_1', 'claude1:toolu_2', 'claude1:toolu_3', 'claude1:toolu_4']);
    // One older than all of those doesn't push a newer one out.
    upsert(daemon, sub('toolu_old', {}, -60));
    expect((await rows(adapter)).map((r) => r.id)).not.toContain('claude1:toolu_old');

    const agents = Array.from({ length: 11 }, (_, i) => claudeAgent({ id: `c${i}` }));
    const many = await setup(agents);
    agents.forEach((_, a) => {
      for (let i = 0; i < 20; i++) upsert(many.daemon, sub(`t${i}`, { parentAgentId: `c${a}` }, a * 20 + i));
    });
    const all = await rows(many.adapter);
    expect(all).toHaveLength(200);
    // The oldest go first, whichever agent ran them.
    expect(all.some((r) => r.parent?.id === 'c0')).toBe(false);
    expect(all.filter((r) => r.parent?.id === 'c10')).toHaveLength(20);
  });

  it("forgets an agent's sub-agents when it closes or goes away", async () => {
    const { adapter, daemon, events } = await setup([claudeAgent(), claudeAgent({ id: 'claude2' })]);
    upsert(daemon, sub('toolu_1'));
    upsert(daemon, sub('toolu_2', { parentAgentId: 'claude2' }));
    expect((await rows(adapter)).map((r) => r.id)).toEqual(['claude1:toolu_1', 'claude2:toolu_2']);

    daemon.emit('agent_update', { kind: 'upsert', agent: daemon.agent('claude1', [], { ...claudeAgent(), status: 'closed' }) });
    expect((await rows(adapter)).map((r) => r.id)).toEqual(['claude2:toolu_2']);
    daemon.emit('agent_update', { kind: 'remove', agentId: 'claude2' });
    expect(await rows(adapter)).toEqual([]);
    const removed = events.flatMap((e) => (e.type === 'conversation_removed' ? [e.id] : []));
    expect(removed).toEqual(['claude1:toolu_1', 'claude2:toolu_2', 'claude2']);
  });

  it('asks Paseo only about agents it has running, of providers that have sub-agents, never Hermes', async () => {
    const extra = [
      claudeAgent(),
      claudeAgent({ id: 'codex1', provider: 'codex' }),
      claudeAgent({ id: 'stored', capabilities: { supportsStreaming: false } }),
      claudeAgent({ id: 'closed', status: 'closed' }),
      claudeAgent({ id: 'hermes1', provider: 'hermes' }),
      claudeAgent({ id: 'pi1', provider: 'pi' }),
    ];
    const daemon = fakeDaemon(extra);
    daemon.state.subagents = { claude1: [sub('toolu_9')], stored: [sub('toolu_s', { parentAgentId: 'stored' })] };
    const hub = new EventHub();
    const adapter = new PaseoAdapter('ws://127.0.0.1:19007', hub, quietLog, 'cid_signalbox_test', () => daemon.client as never, new BackgroundGate('primary'));
    adapter.start();
    await expect.poll(async () => (await rows(adapter)).map((r) => r.id)).toEqual(['claude1:toolu_9']);
    expect([...daemon.subagentLists].sort()).toEqual(['claude1', 'codex1']);

    // Opening a stored agent makes Paseo load it: then it's asked.
    daemon.state.liveAgent = claudeAgent({ id: 'stored' });
    await adapter.getConversation('stored');
    await expect.poll(async () => (await rows(adapter)).map((r) => r.id).sort()).toEqual(['claude1:toolu_9', 'stored:toolu_s']);
    expect(daemon.subagentLists.filter((id) => id === 'stored')).toHaveLength(1);
    // Later news of an agent it already asked about doesn't ask again.
    daemon.emit('agent_update', { kind: 'upsert', agent: daemon.agent('claude1', [], { ...claudeAgent(), status: 'running' }) });
    expect(daemon.subagentLists.filter((id) => id === 'claude1')).toHaveLength(1);
    expect(daemon.subagentLists).not.toContain('hermes1');
  });

  it('asks again after a reconnect, and drops what Paseo no longer has', async () => {
    const extra: Array<{ id: string } & Record<string, unknown>> = [claudeAgent(), claudeAgent({ id: 'claude2' })];
    const { adapter, daemon } = await setup(extra);
    upsert(daemon, sub('toolu_1'));
    upsert(daemon, sub('toolu_2', { parentAgentId: 'claude2' }));
    await expect.poll(() => daemon.subagentLists.length).toBe(2);

    // Meanwhile toolu_1 finished and went, toolu_3 started, and claude2 was unloaded.
    daemon.state.subagents = { claude1: [sub('toolu_3', {}, 5)] };
    Object.assign(extra[1]!, { capabilities: { supportsStreaming: false } });
    daemon.reconnect();
    await expect.poll(async () => (await rows(adapter)).map((r) => r.id)).toEqual(['claude1:toolu_3']);
    expect(daemon.subagentLists.filter((id) => id === 'claude2')).toHaveLength(1);
  });

  it("doesn't ask a daemon that can't list sub-agents", async () => {
    const daemon = fakeDaemon([claudeAgent()]);
    daemon.state.canListSubagents = false;
    const adapter = new PaseoAdapter('ws://127.0.0.1:19007', new EventHub(), quietLog, 'cid_signalbox_test', () => daemon.client as never, new BackgroundGate('primary'));
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    await new Promise((resolve) => setImmediate(resolve));
    expect(daemon.subagentLists).toEqual([]);
    // What the daemon does send still shows.
    upsert(daemon, sub('toolu_1'));
    expect((await rows(adapter)).map((r) => r.id)).toEqual(['claude1:toolu_1']);
  });

  it('opens a sub-agent without asking Paseo, and refuses anything sent to it', async () => {
    const { adapter, daemon } = await setup([claudeAgent()]);
    upsert(daemon, sub('toolu_1'));
    const detail = await adapter.getConversation('claude1:toolu_1');
    expect(detail).toEqual({
      conversation: (await rows(adapter))[0],
      items: [
        {
          kind: 'notice',
          id: 'subagent',
          level: 'info',
          text: 'This is a sub-agent of “Claude agent”. Its work shows in the tool cards of that agent.',
        },
      ],
      approvals: [],
    });
    expect(daemon.loads).toEqual([]);

    for (const id of ['claude1:toolu_1', 'claude1:gone']) {
      await refused(adapter.sendMessage(id, 'hello'));
      await refused(adapter.interrupt(id));
      await refused(adapter.respondToApproval(id, 'perm-1', { optionId: 'allow_once' }));
      await refused(adapter.listCommands(id));
      await refused(adapter.getControls(id));
      await refused(adapter.setControl(id, { control: 'mode', value: 'plan' }));
    }
    expect(daemon.sent).toEqual([]);
    expect(daemon.commandCalls).toEqual([]);
    expect(daemon.configCalls).toEqual([]);
    expect(daemon.responses).toEqual([]);
    await expect(adapter.getConversation('claude1:gone')).rejects.toSatisfy(
      (err: unknown) => err instanceof UserFacingError && err.status === 404,
    );
    expect(daemon.loads).toEqual([]);
  });
});

describe('Claude Code runs started from a shell (claude -p)', () => {
  const RUN = '0c1a0de0-0000-4000-8000-000000000003';
  const OWN = '0c1a0de0-0000-4000-8000-000000000005';
  const CHAT = '20260315_101500_c0ffee';

  it('shows a run under whatever started it, read-only, and never one of Paseo’s own agents', async () => {
    const own = claudeAgent({ id: 'claude1', persistence: { provider: 'claude', sessionId: OWN } });
    const daemon = fakeDaemon([own]);
    const adapter = new PaseoAdapter('ws://127.0.0.1:19007', new EventHub(), quietLog, 'cid_signalbox_test', () => daemon.client as never, new BackgroundGate('primary'));
    const lineage = new Lineage(null, quietLog, undefined, new BackgroundGate('primary'));
    adapter.useLineage(lineage);
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');

    lineage.noteRun(RUN, 'start', { candidates: [{ kind: 'hermes', id: CHAT }], cwd: '/home/me/app/', entrypoint: 'sdk-cli' });
    lineage.noteRun(RUN, 'prompt', { task: 'Audit the repo\nand report' });
    lineage.noteRun(RUN, 'stop', { final: 'Found 2 issues.' });
    // Paseo's own Claude agent fires the same hook with its own PASEO_AGENT_ID: not a run.
    lineage.noteRun(OWN, 'start', { candidates: [{ kind: 'paseo', id: 'claude1' }] });

    const list = await adapter.listConversations();
    expect(list.find((c) => c.id === `crun:${RUN}`)).toMatchObject({
      source: 'paseo',
      parent: { source: 'hermes', id: CHAT },
      subagent: true,
      status: 'idle',
      title: 'Audit the repo and report',
      preview: 'Found 2 issues.',
      agentLabel: 'Claude Code',
      project: { path: '/home/me/app', name: 'app' },
    });
    expect(list.some((c) => c.id === `crun:${OWN}`)).toBe(false);

    const detail = await adapter.getConversation(`crun:${RUN}`);
    expect(detail.items.map((i) => i.kind)).toEqual(['notice', 'user', 'assistant']);
    await expect(adapter.sendMessage(`crun:${RUN}`, 'hi')).rejects.toMatchObject({ status: 400 });
    await expect(adapter.getConversation('crun:00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
    adapter.stop();
  });

  it('lists a run once it has a task or an answer, never a launch that failed before its prompt', async () => {
    const { adapter, events } = await setup();
    const lineage = new Lineage(null, quietLog, undefined, new BackgroundGate('primary'));
    adapter.useLineage(lineage);
    const upserts = (id: string) => events.filter((e) => e.type === 'conversation_upsert' && e.conversation.id === `crun:${id}`);
    const FAILED = '0c1a0de0-0000-4000-8000-000000000006';

    // `claude -p` with a bad argument: SessionStart and SessionEnd, nothing between.
    lineage.noteRun(FAILED, 'start', { candidates: [{ kind: 'hermes', id: CHAT }], entrypoint: 'sdk-cli' });
    lineage.noteRun(FAILED, 'end', {});
    lineage.noteRun(RUN, 'start', { candidates: [{ kind: 'hermes', id: CHAT }], entrypoint: 'sdk-cli' });
    expect(upserts(RUN)).toHaveLength(0);
    lineage.noteRun(RUN, 'prompt', { task: 'Audit the repo' });
    expect(upserts(RUN)).toHaveLength(1);

    const ids = (await adapter.listConversations()).map((c) => c.id);
    expect(ids).toContain(`crun:${RUN}`);
    expect(ids).not.toContain(`crun:${FAILED}`);
    expect(upserts(FAILED)).toHaveLength(0);
    await expect(adapter.getConversation(`crun:${FAILED}`)).rejects.toMatchObject({ status: 404 });
    adapter.stop();
  });
});

describe('Paseo client identity', () => {
  it('sends the installed client version as its app version', () => {
    const installed = JSON.parse(readFileSync(new URL('../../node_modules/@getpaseo/client/package.json', import.meta.url), 'utf8'));
    expect(APP_VERSION).toBe(installed.version);
  });
});

describe('Paseo password', () => {
  it('logs a refused password once, and says so in the status', async () => {
    const daemon = fakeDaemon();
    const warns: string[] = [];
    const log = { info() {}, warn: (_o: object, m: string) => warns.push(m), error() {} };
    const adapter = new PaseoAdapter('ws://127.0.0.1:19007', new EventHub(), log as never, 'cid_signalbox_test', () => daemon.client as never, new BackgroundGate('primary'));
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    daemon.drop('Incorrect password');
    daemon.drop('Incorrect password');   // the client retries: still one log line
    expect(warns.filter((m) => m === 'Paseo refused the connection')).toHaveLength(1);
    expect(adapter.status()).toMatchObject({ state: 'disconnected', message: expect.stringContaining('incorrect password') });
    daemon.drop();
    expect(adapter.status().message).toBe('Reconnecting to Paseo…');
  });
});
