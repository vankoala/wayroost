import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent, TimelineItem } from '../../shared/protocol.js';
import type { Attachment } from '../src/attachments.js';
import { HermesAdapter } from '../src/hermes/adapter.js';
import { blockedReason, catalogCommands, parseSlash, plainOutput, splitUsage } from '../src/hermes/commands.js';
import { SafetyCommandsSetting } from '../src/hermes/safety.js';
import { formatToolResult, skillInvocationText, userContent } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_PNG, FAKE_USER, FakeHermes } from './fake-hermes.js';

const quietLog = { info() {}, warn() {}, error() {} };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('hermes "/" commands', () => {
  it('parses commands but not paths', () => {
    expect(parseSlash('/status')).toEqual({ name: 'status', arg: '' });
    expect(parseSlash('  /Model gpt-5 --provider x\n  more ')).toEqual({ name: 'model', arg: 'gpt-5 --provider x\n  more' });
    expect(parseSlash('/home/me/notes.md what is this')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash('hello /status')).toBeNull();
  });

  it('refuses commands that switch safeguards off', () => {
    expect(blockedReason({ name: 'yolo', arg: '' })).toMatch(/can't be run from Signalbox/);
    expect(blockedReason({ name: 'approve', arg: 'all' })).toMatch(/approval/);
    expect(blockedReason({ name: 'approvals', arg: '' })).toBeNull(); // just shows the mode
    expect(blockedReason({ name: 'approvals', arg: 'off' })).toMatch(/\/approvals off/);
    expect(blockedReason({ name: 'memory', arg: 'approval off' })).toMatch(/memory approval gate/);
    expect(blockedReason({ name: 'memory', arg: 'pending' })).toBeNull();
    expect(blockedReason({ name: 'status', arg: '' })).toBeNull();
  });

  it('lets the safeguard commands through when the setting is on', () => {
    for (const cmd of [
      { name: 'yolo', arg: '' },
      { name: 'approve', arg: 'session' },
      { name: 'approvals', arg: 'off' },
      { name: 'memory', arg: 'approval off' },
      { name: 'skills', arg: 'approval on' },
      { name: 'debug', arg: '' },
    ]) {
      expect(blockedReason(cmd)).not.toBeNull();
      expect(blockedReason(cmd, true)).toBeNull();
    }
    const catalog = { categories: [{ name: 'Configuration', pairs: [['/yolo', 'Toggle YOLO'], ['/debug', 'Debug']] }] };
    expect(catalogCommands(catalog).map((c) => c.name)).toEqual([]);
    expect(catalogCommands(catalog, { allowSafety: true }).map((c) => c.name)).toEqual(['yolo', 'debug']);
  });

  it('keeps the safety-commands setting off unless saved on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-safety-'));
    expect(new SafetyCommandsSetting(dir).enabled()).toBe(false);
    new SafetyCommandsSetting(dir).setEnabled(true);
    const reloaded = new SafetyCommandsSetting(dir);
    expect(reloaded.enabled()).toBe(true);
    reloaded.setEnabled(false);
    expect(new SafetyCommandsSetting(dir).enabled()).toBe(false);
    writeFileSync(join(dir, 'hermes-safety-commands.json'), '{"enabled":"yes"}');
    expect(new SafetyCommandsSetting(dir).enabled()).toBe(false);
  });

  it('builds the menu like the desktop app: sections, then skills by use', () => {
    const commands = catalogCommands({
      pairs: [['/plan', 'Plan'], ['/research', 'Research'], ['/status', 'Status']],
      canon: { '/reset': '/new', '/new': '/new' },
      sub: { '/reasoning': ['low', 'high', '--global'] },
      commands: { '/clear': { desktop: 'terminal' }, '/new': { desktop: null } },
      categories: [
        {
          name: 'Session',
          pairs: [
            ['/new', 'Start a new session (usage: /new [name])'],
            ['/clear', 'Clear screen'],
            ['/yolo', 'Toggle YOLO'],
            ['/skin', 'Theme'],
          ],
        },
        { name: 'Configuration', pairs: [['/reasoning', 'Effort (usage: /reasoning [level])']] },
      ],
      skills: { '/plan': { usage: 1 }, '/research': { usage: 5 } },
    });
    expect(commands.map((c) => c.name)).toEqual(['new', 'reasoning', 'research', 'plan']);
    expect(commands[0]).toMatchObject({ description: 'Start a new session', args: '[name]', aliases: ['reset'], action: 'new', group: 'Session' });
    expect(commands[1]).toMatchObject({ options: ['low', 'high'], kind: 'command' });
    expect(commands[2]).toMatchObject({ kind: 'skill', group: 'Skills' });
    expect(catalogCommands({ categories: [{ name: 'Session', pairs: [['/new', 'x'], ['/stop', 'y']] }] }, { newChat: true })).toEqual([]);
  });

  it('cleans terminal output and usage hints', () => {
    expect(plainOutput('\u001b[1;32mok\u001b[0m\r\nline 2\u0007\n\n')).toBe('ok\nline 2');
    expect(splitUsage('Set a title (usage: /title [name])')).toEqual({ description: 'Set a title', args: '[name]' });
    expect(splitUsage('No hint')).toEqual({ description: 'No hint', args: '' });
  });

  it('shows stored turns as typed: files as chips, skills collapsed', () => {
    expect(userContent('@file:/h/attachments/a.pdf\n@file:"/h/my notes.md"\n\nSummarize\n@image:/h/images/upload_1.png')).toEqual({
      text: 'Summarize',
      attachments: [
        { name: 'a.pdf', kind: 'pdf' },
        { name: 'my notes.md', kind: 'text' },
        { name: 'upload_1.png', kind: 'image' },
      ],
    });
    expect(userContent('compare @file:a.ts with this').attachments).toEqual([]);
    // Native-vision turns: image parts never reach the phone, only the chip.
    const parts = [
      { type: 'text', text: 'What is this?\n@image:/h/images/upload_2.jpg' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ];
    expect(userContent(parts)).toEqual({ text: 'What is this?', attachments: [{ name: 'upload_2.jpg', kind: 'image' }] });
    expect(userContent([{ type: 'text', text: 'old turn' }, { type: 'image_url', image_url: { url: 'data:x' } }])).toEqual({
      text: 'old turn',
      attachments: [{ name: 'Image 1', kind: 'image' }],
    });
    const scaffold =
      '[IMPORTANT: The user has invoked the "plan" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n…body…\n\nThe user has provided the following instruction alongside the skill invocation: fix  the login\n\n[Runtime note: x]';
    expect(skillInvocationText(scaffold)).toBe('/plan fix the login');
    expect(skillInvocationText('just text')).toBeNull();
  });
});

describe('hermes adapter: attachments and commands', () => {
  let fake: FakeHermes;
  let events: ServerEvent[];
  let adapter: HermesAdapter;

  const items = () => {
    const byId = new Map<string, TimelineItem>();
    for (const e of events) {
      if (e.type === 'items_upsert' || e.type === 'items_replace') for (const item of e.items) byId.set(item.id, item);
    }
    return [...byId.values()];
  };
  const calls = (method: string) => fake.calls.filter((c) => c.method === method).map((c) => c.params);

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    const hub = new EventHub();
    events = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (p: string) => events.push(JSON.parse(p)), terminate() {} };
    const client = hub.add(socket as never, 'owner@example.com');
    hub.subscribe(client, 'hermes', FakeHermes.stored);
    hub.subscribe(client, 'hermes', '20260927_090000_bbbbbb');
    const stateDir = mkdtempSync(join(tmpdir(), 'sb-hermes-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
    adapter = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog, { commandWaitMs: 300 });
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
  });

  afterEach(async () => {
    adapter.stop();
    await fake.stop();
  });

  it('uploads files before the prompt and shows them on the message', async () => {
    const files: Attachment[] = [
      { name: 'shot.heic', mimeType: 'image/png', kind: 'image', bytes: PNG },
      { name: 'notes.md', mimeType: 'text/markdown', kind: 'text', bytes: Buffer.from('# hi') },
    ];
    await adapter.sendMessage(FakeHermes.stored, 'What changed?', files);

    expect(calls('image.attach_bytes')).toEqual([
      { session_id: FakeHermes.runtime, content_base64: PNG.toString('base64'), filename: 'shot.png' },
    ]);
    expect(calls('file.attach')).toEqual([
      { session_id: FakeHermes.runtime, name: 'notes.md', path: '', data_url: `data:text/markdown;base64,${Buffer.from('# hi').toString('base64')}` },
    ]);
    const order = fake.calls.map((c) => c.method).filter((m) => /attach|prompt/.test(m));
    expect(order).toEqual(['image.attach_bytes', 'file.attach', 'prompt.submit']);
    expect(calls('prompt.submit')[0]).toEqual({
      session_id: FakeHermes.runtime,
      text: '@file:/hermes/attachments/notes.md\n\nWhat changed?',
    });
    expect(items().find((i) => i.id === 'm200')).toMatchObject({
      kind: 'user',
      text: 'What changed?',
      attachments: [{ name: 'shot.heic', kind: 'image' }, { name: 'notes.md', kind: 'text' }],
    });
  });

  it('uploads a spreadsheet like any other file, as bytes for Hermes to save', async () => {
    const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]);
    await adapter.sendMessage(FakeHermes.stored, 'Sum column B', [{ name: 'budget.xlsx', mimeType: XLSX, kind: 'file', bytes }]);
    expect(calls('file.attach')).toEqual([
      { session_id: FakeHermes.runtime, name: 'budget.xlsx', path: '', data_url: `data:${XLSX};base64,${bytes.toString('base64')}` },
    ]);
    expect(calls('prompt.submit')[0]).toMatchObject({ text: '@file:/hermes/attachments/budget.xlsx\n\nSum column B' });
    expect(items().find((i) => i.id === 'm200')).toMatchObject({ attachments: [{ name: 'budget.xlsx', kind: 'file' }] });
  });

  it('asks a question for image-only messages, and cleans up after a failed upload', async () => {
    const image: Attachment = { name: 'a.png', mimeType: 'image/png', kind: 'image', bytes: PNG };
    await adapter.sendMessage(FakeHermes.stored, '', [image]);
    expect(calls('prompt.submit').at(-1)).toMatchObject({ text: 'What do you see in this image?' });
    fake.event('message.complete', { text: 'A cat.', status: 'complete' });
    await expect.poll(async () => (await adapter.listConversations())[0]?.status).toBe('idle');

    fake.handlers['file.attach'] = () => ({ error: { code: 5028, message: 'disk full' } });
    const text: Attachment = { name: 'b.txt', mimeType: 'text/plain', kind: 'text', bytes: Buffer.from('b') };
    await expect(adapter.sendMessage(FakeHermes.stored, 'hi', [image, text])).rejects.toThrow(/disk full/);
    expect(calls('image.detach')).toHaveLength(1);
    expect(calls('prompt.submit')).toHaveLength(1);
  });

  it('refuses files while a turn is running', async () => {
    await adapter.getConversation(FakeHermes.stored);
    fake.event('message.start');
    await expect.poll(() => items().length >= 0 && events.some((e) => e.type === 'conversation_upsert')).toBe(true);
    await expect.poll(async () => (await adapter.listConversations())[0]?.status).toBe('running');
    const image: Attachment = { name: 'a.png', mimeType: 'image/png', kind: 'image', bytes: PNG };
    await expect(adapter.sendMessage(FakeHermes.stored, 'look', [image])).rejects.toBeInstanceOf(UserFacingError);
    expect(calls('image.attach_bytes')).toEqual([]);
  });

  it('runs commands, dispatches skills, and never runs blocked ones', async () => {
    const status = await adapter.sendMessage(FakeHermes.stored, '/status');
    expect(status).toMatchObject({ items: [{ kind: 'command', command: '/status', output: 'ran status' }] });
    expect(calls('slash.exec')[0]).toEqual({ session_id: FakeHermes.runtime, command: 'status' });

    const plan = await adapter.sendMessage(FakeHermes.stored, '/plan fix the login');
    expect(plan).toEqual({ items: [] });
    expect(calls('command.dispatch')[0]).toEqual({ session_id: FakeHermes.runtime, name: 'plan', arg: 'fix the login' });
    expect(calls('prompt.submit')[0]).toMatchObject({ text: expect.stringContaining('invoked the "plan" skill') });
    expect(items().find((i) => i.id === 'm200')).toMatchObject({ kind: 'user', text: '/plan fix the login' });

    const undo = await adapter.sendMessage(FakeHermes.stored, '/undo');
    expect(undo).toMatchObject({ prefill: 'Run the tests', items: [{ output: '↶ Undid 1 turn (2 message(s)).' }] });
    await expect.poll(() => events.some((e) => e.type === 'items_replace')).toBe(true);

    const before = fake.calls.length;
    const yolo = await adapter.sendMessage(FakeHermes.stored, '/yolo');
    expect(yolo).toMatchObject({ items: [{ error: true, output: expect.stringMatching(/For safety/) }] });
    expect(fake.calls.length).toBe(before);

    // Command output is kept and comes back with the conversation.
    const detail = await adapter.getConversation(FakeHermes.stored);
    expect(detail.items.filter((i) => i.kind === 'command').map((i) => (i as { command: string }).command)).toEqual([
      '/status',
      '/undo',
      '/yolo',
    ]);
  });

  it('answers slow commands as running and finishes them live', async () => {
    let finish!: (value: unknown) => void;
    fake.handlers['slash.exec'] = () => new Promise((resolve) => (finish = resolve));
    const result = await adapter.sendMessage(FakeHermes.stored, '/compress');
    expect(result).toMatchObject({ items: [{ kind: 'command', running: true, output: '' }] });
    const id = (result as { items: TimelineItem[] }).items[0]!.id;
    finish({ type: 'exec', output: 'Compressed 40 → 12 messages' });
    await expect.poll(() => items().find((i) => i.id === id)).toMatchObject({ output: 'Compressed 40 → 12 messages' });
    expect(items().find((i) => i.id === id)).not.toHaveProperty('running');
  });

  it('lists commands for the menu', async () => {
    const commands = await adapter.listCommands(FakeHermes.stored);
    expect(commands.map((c) => c.name)).toEqual(['new', 'status', 'reasoning', 'research', 'plan']);
    expect(calls('commands.catalog')[0]).toEqual({ session_id: FakeHermes.runtime });
    expect((await adapter.listNewChatCommands()).map((c) => c.name)).toEqual(['status', 'reasoning', 'research', 'plan']);
  });

  it('offers model and reasoning pickers, and switches for this chat only', async () => {
    fake.handlers['model.options'] = () => ({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      providers: [
        {
          slug: 'anthropic',
          name: 'Anthropic',
          models: ['claude-sonnet-5', 'claude-opus-5', 'retired-model'],
          unavailable_models: ['retired-model'],
          capabilities: { 'claude-sonnet-5': { fast: false, reasoning: true, can_disable_reasoning: false } },
          pricing: { 'claude-opus-5': { input: '$15', output: '$75', free: false } },
        },
        { slug: 'nokey', name: 'No key', models: ['x'], authenticated: false },
      ],
    });
    let expensive = true;
    fake.handlers['config.set'] = (params) =>
      params.key === 'model' && expensive && !params.confirm_expensive_model
        ? { key: 'model', value: '', confirm_required: true, confirm_message: 'Opus costs 5× more. Switch?' }
        : { key: params.key, value: params.value, deferred: params.key === 'model' };

    await adapter.getConversation(FakeHermes.stored);
    fake.event('session.info', { reasoning_effort: 'high', usage: { context_used: 1200, context_max: 200000 } });
    await expect.poll(async () => (await adapter.getControls(FakeHermes.stored)).context).toEqual({ used: 1200, max: 200000 });

    const { controls } = await adapter.getControls(FakeHermes.stored);
    const [model, reasoning] = controls;
    expect(model).toMatchObject({ id: 'model', value: '["anthropic","claude-sonnet-5"]', valueLabel: 'claude-sonnet-5' });
    expect(model!.options).toEqual([
      { id: '["anthropic","claude-sonnet-5"]', label: 'claude-sonnet-5', group: 'Anthropic' },
      { id: '["anthropic","claude-opus-5"]', label: 'claude-opus-5', group: 'Anthropic', description: '$15 in · $75 out per M tokens' },
    ]);
    expect(reasoning).toMatchObject({ id: 'reasoning', value: 'high' });
    expect(reasoning!.options.map((o) => o.id)).not.toContain('none'); // this model can't turn it off

    await expect(adapter.setControl(FakeHermes.stored, { control: 'model', value: '["nokey","x"]' })).rejects.toBeInstanceOf(
      UserFacingError,
    );
    const opus = '["anthropic","claude-opus-5"]';
    expect(await adapter.setControl(FakeHermes.stored, { control: 'model', value: opus })).toEqual({
      ok: false,
      confirm: 'Opus costs 5× more. Switch?',
    });
    const switched = await adapter.setControl(FakeHermes.stored, { control: 'model', value: opus, confirm: true });
    expect(switched).toMatchObject({ ok: true, notice: 'Takes effect on the next turn.' });
    expect(calls('config.set').at(-1)).toEqual({
      session_id: FakeHermes.runtime,
      key: 'model',
      value: 'claude-opus-5 --provider anthropic --session',
      confirm_expensive_model: true,
    });
    expect((switched as { controls: { controls: Array<{ value: string | null }> } }).controls.controls[0]!.value).toBe(opus);

    expensive = false;
    await adapter.setControl(FakeHermes.stored, { control: 'reasoning', value: 'low' });
    expect(calls('config.set').at(-1)).toEqual({ session_id: FakeHermes.runtime, key: 'reasoning', value: 'low' });
  });

  it('starts a new chat on a picked model, for that chat only, and checks the pick first', async () => {
    fake.handlers['model.options'] = () => ({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      providers: [
        {
          slug: 'anthropic',
          name: 'Anthropic',
          models: ['claude-sonnet-5', 'claude-opus-5'],
          pricing: { 'claude-opus-5': { input: '$15', output: '$75', free: false } },
        },
        { slug: 'nokey', name: 'No key', models: ['x'], authenticated: false },
      ],
    });
    fake.handlers['config.set'] = (params) =>
      params.key === 'model' && String(params.value).startsWith('claude-opus-5') && !params.confirm_expensive_model
        ? { key: 'model', value: '', confirm_required: true, confirm_message: 'Opus costs 5× more. Switch?' }
        : { key: params.key, value: params.value, deferred: true };
    const opus = '["anthropic","claude-opus-5"]';

    // The same list a running chat's model control offers, and Hermes' default.
    expect(await adapter.newChatOptions()).toEqual({
      models: [
        { id: '["anthropic","claude-sonnet-5"]', label: 'claude-sonnet-5', group: 'Anthropic' },
        { id: opus, label: 'claude-opus-5', group: 'Anthropic', description: '$15 in · $75 out per M tokens' },
      ],
      defaultModel: '["anthropic","claude-sonnet-5"]',
    });

    // A model that isn't offered never creates a chat.
    await expect(adapter.createConversation('hi', undefined, [], { model: '["nokey","x"]' })).rejects.toMatchObject({ status: 400 });
    expect(calls('session.create')).toEqual([]);

    // Hermes asks before an expensive one: without the yes, no prompt goes out.
    await expect(adapter.createConversation('hi', undefined, [], { model: opus })).rejects.toMatchObject({ status: 409 });
    expect(calls('prompt.submit')).toEqual([]);

    await adapter.createConversation('Summarise the repo', undefined, [], { model: opus, confirmModel: true });
    const order = fake.calls.map((c) => c.method).filter((m) => ['session.create', 'config.set', 'prompt.submit'].includes(m));
    expect(order.slice(-3)).toEqual(['session.create', 'config.set', 'prompt.submit']);
    expect(calls('config.set').at(-1)).toEqual({
      session_id: 'feedbeef', // the new chat's own session
      key: 'model',
      value: 'claude-opus-5 --provider anthropic --session',
      confirm_expensive_model: true,
    });
  });

  it("says so when Hermes starts a new chat somewhere other than the folder asked for", async () => {
    // Like Hermes: it keeps a folder only if it exists, and otherwise starts where the gateway runs.
    fake.handlers['session.create'] = (params) => ({
      session_id: 'feedbeef',
      stored_session_id: '20260927_070000_aaaaaa',
      messages: [],
      info: { cwd: params.cwd === '/home/me/code/app/' || params.cwd === '/home/me/code/./app' ? '/home/me/code/app' : '/home/me' },
    });
    expect(await adapter.createConversation('hi', '/home/me/typo')).toMatchObject({ notice: 'Hermes started this chat in ~, not ~/typo.' });
    // The same folder, written another way, is no news; nor is a chat that asked for no folder.
    expect((await adapter.createConversation('hi', '/home/me/code/app/')).notice).toBeUndefined();
    // Kept: its header names the folder, and Projects places it, before Hermes' list next says so.
    const upserts = events.filter((e) => e.type === 'conversation_upsert' && e.conversation.id === '20260927_070000_aaaaaa');
    expect(upserts.at(-1)).toMatchObject({ conversation: { subtitle: '~/code/app', project: { path: '/home/me/code/app' } } });
    expect((await adapter.createConversation('hi', '/home/me/code/./app')).notice).toBeUndefined();
    expect((await adapter.createConversation('hi')).notice).toBeUndefined();
  });

  it('reads images through the dashboard, within its rules and a size cap', async () => {
    const image = await adapter.readImage(FakeHermes.stored, '/home/me/Pictures/garden.png');
    expect(image.bytes.equals(FAKE_PNG)).toBe(true);
    expect(fake.downloads[0]).toEqual({ path: '/home/me/Pictures/garden.png', session_id: FakeHermes.stored });
    await expect(adapter.readImage(FakeHermes.stored, '/home/me/secret.png')).rejects.toMatchObject({ status: 403 });
    await expect(adapter.readImage(FakeHermes.stored, '/home/me/gone.png')).rejects.toMatchObject({ status: 404 });
    await expect(adapter.readImage(FakeHermes.stored, '/home/me/huge.png')).rejects.toMatchObject({ status: 413 });
  });

  it('shows what a vision tool concluded, not the image data it was given', () => {
    const result = {
      _multimodal: true,
      content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(500)}` } }],
      text_summary: 'A red square on white.',
    };
    expect(formatToolResult(result)).toBe('A red square on white.');
    expect(formatToolResult(`before data:image/jpeg;base64,${'B'.repeat(300)} after`)).toBe('before [image] after');
  });

  it('follows a chat that Hermes continues under a new id after compressing', async () => {
    await adapter.getConversation(FakeHermes.stored);
    fake.event('session.info', { running: false, stored_session_id: '20260927_090000_bbbbbb' });
    await expect.poll(() => events.find((e) => e.type === 'conversation_moved')).toEqual({
      type: 'conversation_moved',
      source: 'hermes',
      from: FakeHermes.stored,
      to: '20260927_090000_bbbbbb',
    });
    fake.event('message.start');
    fake.event('message.delta', { text: 'continuing' });
    await expect
      .poll(() => events.some((e) => e.type === 'items_upsert' && e.conversationId === '20260927_090000_bbbbbb'))
      .toBe(true);
  });
});
