import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../shared/protocol';
import { NO_PROJECT, canonicalFolder, chatIndex, groupByProject, isBareFolder, parentOf, type ProjectGroup } from './projects';

const conv = (partial: Partial<ConversationSummary> & Pick<ConversationSummary, 'source' | 'id'>): ConversationSummary => ({
  title: partial.id,
  status: 'idle',
  updatedAt: 1,
  pendingApprovals: 0,
  ...partial,
});

const garden = { path: '/home/me/garden-app', name: 'garden-app' };

describe('groupByProject', () => {
  const conversations = [
    conv({ source: 'paseo', id: 'm1', title: 'M1 gateway', project: garden, hermesInPaseo: true, updatedAt: 50 }),
    conv({ source: 'paseo', id: 'review', project: garden, parent: { source: 'paseo', id: 'm1' }, updatedAt: 40 }),
    conv({ source: 'paseo', id: 'nit', project: garden, parent: { source: 'paseo', id: 'review' }, updatedAt: 45 }),
    conv({ source: 'hermes', id: 'h-sub', project: { path: '/home/me/garden-app/web', name: 'web' }, updatedAt: 30 }),
    conv({ source: 'hermes', id: 'h-free', updatedAt: 99 }),
    conv({ source: 'paseo', id: 'orphan', project: { path: '/home/me/notes', name: 'notes' }, parent: { source: 'paseo', id: 'gone' }, updatedAt: 10 }),
    conv({ source: 'paseo', id: 'waiting', project: { path: '/home/me/notes', name: 'notes' }, status: 'needs_approval', updatedAt: 5 }),
  ];
  const groups = groupByProject(conversations, (c) => c.status === 'needs_approval');

  it('puts Hermes chats inside a Paseo project folder into that project', () => {
    const k = groups.find((g) => g.name === 'garden-app')!;
    expect(k.hermes.map((n) => n.conversation.id)).toEqual(['h-sub']);
    expect(k.path).toBe('/home/me/garden-app');
  });

  it('nests chats under the thread that started them', () => {
    const k = groups.find((g) => g.name === 'garden-app')!;
    expect(k.paseo).toHaveLength(1);
    expect(k.paseo[0]!.conversation.id).toBe('m1');
    expect(k.paseo[0]!.children.map((c) => [c.conversation.id, c.parentTitle])).toEqual([
      ['nit', 'review'],
      ['review', undefined],
    ]);
  });

  it('keeps agents whose parent is gone at the top level', () => {
    const p = groups.find((g) => g.name === 'notes')!;
    expect(p.paseo.map((n) => n.conversation.id)).toEqual(['waiting', 'orphan']);
  });

  it('orders projects needing attention first and folderless chats last', () => {
    expect(groups.map((g) => g.key)).toEqual(['/home/me/notes', '/home/me/garden-app', NO_PROJECT]);
    expect(groups.at(-1)).toMatchObject({ name: 'Other chats', path: null });
    expect(groups[0]!.attention).toBe(1);
  });
});

describe('project folders, as the bridge sees them', () => {
  const keys = (list: ConversationSummary[]) => groupByProject(list, () => false).map((g) => g.key).sort();
  const groupOf = (list: ConversationSummary[], id: string) =>
    groupByProject(list, () => false).find((g) => g.members.some((c) => c.id === id))?.key;
  const at = (source: 'hermes' | 'paseo', id: string, path: string) =>
    conv({ source, id, project: { path, name: path.split('/').pop() || path } });

  it('keeps nested Hermes-only folders apart (a chat stands on its own folder)', () => {
    const list = [at('hermes', 'outer', '/srv/site'), at('hermes', 'inner', '/srv/site/blog')];
    expect(keys(list)).toEqual(['/srv/site', '/srv/site/blog']);
  });

  it('puts Hermes chats inside a Paseo root into it, and nested Paseo roots on their own', () => {
    const list = [at('paseo', 'app', '/srv/app'), at('paseo', 'lib', '/srv/app/vendor/lib'), at('hermes', 'deep', '/srv/app/vendor/lib/src')];
    expect(groupOf(list, 'deep')).toBe('/srv/app/vendor/lib');
    expect(groupOf(list, 'app')).toBe('/srv/app');
  });

  it.each(['/', '/home', '/home/me', '/root'])('never makes a project of %s', (bare) => {
    const list = [at('paseo', 'wide', bare), at('hermes', 'here', bare), at('hermes', 'notes', '/home/me/notes')];
    // Chats there go to "Other chats", and the folder swallows nothing under it.
    expect(groupOf(list, 'wide')).toBe(NO_PROJECT);
    expect(groupOf(list, 'here')).toBe(NO_PROJECT);
    expect(groupOf(list, 'notes')).toBe('/home/me/notes');
  });

  it('compares folders in canonical form, by whole path segments', () => {
    const list = [
      at('paseo', 'a', '/srv/app/'),
      at('hermes', 'b', '/srv/tmp/../app/src'),
      at('hermes', 'c', '/srv/application'),
    ];
    expect(groupOf(list, 'b')).toBe('/srv/app');
    expect(groupOf(list, 'c')).toBe('/srv/application');
    expect(canonicalFolder('/srv//app/./x/..')).toBe('/srv/app');
    expect(canonicalFolder('relative')).toBeNull();
    expect(isBareFolder('/home/me')).toBe(true);
    expect(isBareFolder('/home/me/code')).toBe(false);
  });

  it('names a folder after its Paseo project first, else its first Hermes chat', () => {
    const list = [
      conv({ source: 'hermes', id: 'h', project: { path: '/srv/app/src', name: 'src' } }),
      conv({ source: 'hermes', id: 'h2', project: { path: '/srv/app', name: 'from hermes' } }),
      conv({ source: 'paseo', id: 'p', project: { path: '/srv/app', name: 'My App' } }),
    ];
    expect(groupByProject(list, () => false).map((g) => [g.key, g.name])).toEqual([['/srv/app', 'My App']]);
  });
});

describe('nesting across backends', () => {
  const app = { path: '/srv/app', name: 'app' };
  const hermes = (id: string, extra: Partial<ConversationSummary> = {}) => conv({ source: 'hermes', id, project: app, ...extra });
  const paseo = (id: string, extra: Partial<ConversationSummary> = {}) => conv({ source: 'paseo', id, project: app, ...extra });
  const from = (source: 'hermes' | 'paseo', id: string) => ({ parent: { source, id } });
  const group = (list: ConversationSummary[], needsYou = (_c: ConversationSummary) => false): ProjectGroup =>
    groupByProject(list, needsYou)[0]!;
  const ids = (entries: Array<{ conversation: ConversationSummary }>) => entries.map((e) => e.conversation.id);

  it('puts what a Hermes chat started under it, in the Hermes lane', () => {
    const g = group([hermes('plan'), paseo('proto', from('hermes', 'plan'))]);
    expect(g.paseo).toEqual([]);
    expect(g.hermes.map((n) => [n.conversation.id, ids(n.children)])).toEqual([['plan', ['proto']]]);
  });

  it('finds a parent by any id it was known by', () => {
    const list = [
      paseo('agent', { hermesInPaseo: true, aliases: [{ source: 'hermes', id: 'acp-1' }] }),
      hermes('run-1', { ...from('hermes', 'acp-1'), subagent: true }),
      // A primary id always wins over someone else's alias.
      hermes('acp-2'),
      paseo('other', { aliases: [{ source: 'hermes', id: 'acp-2' }] }),
    ];
    expect(parentOf(list[1]!, chatIndex(list))?.id).toBe('agent');
    expect(chatIndex(list).get('hermes:acp-2')?.id).toBe('acp-2');
    const agent = group(list).paseo.find((n) => n.conversation.id === 'agent')!;
    expect(ids(agent.subagents)).toEqual(['run-1']);
  });

  it('folds sub-agents under the chat that ran them, however deep', () => {
    const g = group([
      hermes('plan'),
      hermes('d1', { ...from('hermes', 'plan'), subagent: true }),
      hermes('d1a', { ...from('hermes', 'd1'), subagent: true }),
      paseo('proto', from('hermes', 'plan')),
      paseo('task', { ...from('paseo', 'proto'), subagent: true }),
    ]);
    const plan = g.hermes[0]!;
    expect(plan.subagents.map((e) => [e.conversation.id, e.parentTitle])).toEqual([
      ['d1', undefined],
      ['d1a', 'd1'],
    ]);
    expect(plan.children.map((c) => [c.conversation.id, ids(c.subagents)])).toEqual([['proto', ['task']]]);
  });

  it('keeps chats in their own project, but takes sub-agents to their root', () => {
    const list = [
      hermes('plan'),
      conv({ source: 'paseo', id: 'elsewhere', project: { path: '/srv/site', name: 'site' }, ...from('hermes', 'plan') }),
      conv({ source: 'hermes', id: 'loose-run', ...from('hermes', 'plan'), subagent: true }),
    ];
    const groups = groupByProject(list, () => false);
    expect(groups.find((g) => g.key === '/srv/site')!.paseo.map((n) => n.conversation.id)).toEqual(['elsewhere']);
    expect(ids(groups.find((g) => g.key === '/srv/app')!.hermes[0]!.subagents)).toEqual(['loose-run']);
  });

  it('shows an orphaned sub-agent only while it works, on its own', () => {
    const g = group([
      hermes('stale', { ...from('hermes', 'gone'), subagent: true }),
      paseo('busy', { ...from('paseo', 'gone'), subagent: true, status: 'running' }),
      paseo('lonely', from('paseo', 'gone')),
    ]);
    expect(g.members.map((c) => c.id).sort()).toEqual(['busy', 'lonely']);
    expect(g.paseo.map((n) => n.conversation.id).sort()).toEqual(['busy', 'lonely']);
  });

  it('ranks a thread by its most urgent member, then its newest update', () => {
    const g = group(
      [
        hermes('quiet', { updatedAt: 90 }),
        hermes('busy-parent', { updatedAt: 10 }),
        hermes('its-run', { ...from('hermes', 'busy-parent'), subagent: true, status: 'running', updatedAt: 5 }),
        hermes('asking', { updatedAt: 1, status: 'needs_approval' }),
        hermes('fresh', { updatedAt: 95 }),
      ],
      (c) => c.status === 'needs_approval',
    );
    expect(g.hermes.map((n) => n.conversation.id)).toEqual(['asking', 'busy-parent', 'fresh', 'quiet']);
  });

  it('lists sub-agents working first, then newest', () => {
    const g = group([
      hermes('plan'),
      hermes('old', { ...from('hermes', 'plan'), subagent: true, updatedAt: 1 }),
      hermes('new', { ...from('hermes', 'plan'), subagent: true, updatedAt: 9 }),
      hermes('working', { ...from('hermes', 'plan'), subagent: true, status: 'running', updatedAt: 2 }),
    ]);
    expect(ids(g.hermes[0]!.subagents)).toEqual(['working', 'new', 'old']);
  });

  it('counts chats by their own backend and sub-agents apart', () => {
    const g = group([
      hermes('plan'),
      paseo('proto', from('hermes', 'plan')),
      paseo('task', { ...from('paseo', 'proto'), subagent: true }),
      hermes('run', { ...from('hermes', 'plan'), subagent: true }),
    ]);
    expect(g.counts).toEqual({ hermes: 1, paseo: 1, subagents: 2 });
  });

  it('survives a loop in the links', () => {
    const g = group([hermes('a', from('hermes', 'b')), hermes('b', from('hermes', 'a'))]);
    expect(g.members.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(g.hermes).toHaveLength(1);
  });
});
