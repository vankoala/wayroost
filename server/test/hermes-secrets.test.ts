import { BackgroundGate } from '../src/background.js';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, ServerEvent, TimelineItem } from '../../shared/protocol.js';
import { buildApp } from '../src/app.js';
import { HermesAdapter, type Logger } from '../src/hermes/adapter.js';
import { MAX_SECRET_CHARS, SECRET_DECLINE, secretAnswer, secretApproval } from '../src/hermes/normalize.js';
import { EventHub } from '../src/hub.js';
import { SecretStore } from '../src/secrets.js';
import { createAccessVerifier } from '../src/security/access.js';
import { UserFacingError } from '../src/sources.js';
import { FAKE_USER, FakeHermes } from './fake-hermes.js';
import { EMAIL, FakePaseo, makeApp, makeConfig, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

// Hermes' password prompts (sudo, secret, vault unlock, 2FA code, saving a
// login): a notice by default, secret cards when `hermes.secretPrompts` is on.
// Request shapes follow hermes-agent tui_gateway/agent_callbacks.py and
// tui_gateway/contracts/server_requests.py.

const STORED = FakeHermes.stored;
/** Stand in for real secrets: they must reach Hermes and show up nowhere else. */
const MARKER = 'pw-7f3a9c1e-correct-horse';
const LOGIN_ID = 'id-5b2e8d41-me@example.com';
const LOGIN_PW = 'pw-9c4f1a7d-login-secret';
const MARKERS = [MARKER, LOGIN_ID, LOGIN_PW];
const NOTICE = 'Hermes is asking for a password or secret. For safety, answer it in the Hermes desktop app or terminal.';
const quietLog: Logger = { info() {}, warn() {}, error() {} };

const PROMPTS: Array<[string, Record<string, unknown>]> = [
  ['sudo', { command: 'apt install ripgrep' }],
  ['secret', { env_var: 'OPENAI_API_KEY', prompt: 'Enter your OpenAI API key', metadata: { skill_name: 'research' } }],
  ['vault.unlock_prompt', { backend: 'onepassword', display_name: '1Password' }],
  ['vault.save_login', { origin: 'https://github.com', site: 'github.com' }],
  ['vault.code', { site: 'github.com', hint: '' }],
];

/** Everything published on the hub, whether or not a browser is watching. */
function recordPublished(hub: EventHub): ServerEvent[] {
  const published: ServerEvent[] = [];
  const publish = hub.publish.bind(hub);
  hub.publish = (event: ServerEvent) => {
    published.push(event);
    publish(event);
  };
  return published;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
}

function expectNoMarkers(texts: string[]): void {
  for (const text of texts) for (const marker of MARKERS) expect(text).not.toContain(marker);
}

describe('hermes secret cards', () => {
  it('asks for sudo with the command it will run, and wants a second tap', () => {
    expect(secretApproval('srq-1', 's1', 'sudo', { command: 'apt install ripgrep' }, 5)).toEqual({
      id: 'srq-1',
      source: 'hermes',
      conversationId: 's1',
      kind: 'secret',
      secret: { input: 'password', confirm: true },
      title: 'Hermes asks for your sudo password',
      detail: 'apt install ripgrep',
      options: [{ id: SECRET_DECLINE, label: 'Decline', kind: 'deny' }],
      createdAt: 5,
    });
    const blind = secretApproval('srq-2', 's1', 'sudo', {}, 5)!;
    expect(blind.title).toBe('Hermes asks for your sudo password without saying what it will run');
    expect(blind.detail).toBeUndefined();
  });

  it('names the secret, the vault or the site, and asks for codes on a keypad', () => {
    const secret = secretApproval('a', 's1', 'secret', { env_var: 'OPENAI_API_KEY', prompt: 'Enter your OpenAI API key' }, 0)!;
    expect(secret).toMatchObject({
      title: 'Hermes asks for OPENAI_API_KEY',
      detail: 'Enter your OpenAI API key',
      secret: { input: 'password' },
      options: [{ id: SECRET_DECLINE, label: 'Skip', kind: 'deny' }],
    });
    expect(secret.secret!.confirm).toBeUndefined();
    expect(secretApproval('b', 's1', 'vault.unlock_prompt', { backend: 'onepassword', display_name: '1Password' }, 0)).toMatchObject({
      title: 'Vault master password for 1Password',
      secret: { input: 'password' },
      options: [{ id: SECRET_DECLINE, label: 'Keep locked', kind: 'deny' }],
    });
    const code = secretApproval('c', 's1', 'vault.code', { site: 'github.com', hint: '' }, 0)!;
    expect(code).toMatchObject({ title: '2FA code for github.com', secret: { input: 'code' } });
    expect(code.detail).toBeUndefined();
    expect(secretApproval('d', 's1', 'vault.code', { site: 'github.com', hint: 'From your authenticator app' }, 0)!.detail).toBe(
      'From your authenticator app',
    );
    expect(secretApproval('e', 's1', 'vault.code', {}, 0)!.title).toBe('2FA code');
    expect(secretApproval('f', 's1', 'secret', {}, 0)!.title).toBe('Hermes asks for a secret');
    expect(secretApproval('g', 's1', 'vault.unlock_prompt', {}, 0)!.title).toBe('Vault master password');
  });

  it('asks for a login to save, showing the exact origin it is for', () => {
    expect(secretApproval('srq-1', 's1', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' }, 5)).toEqual({
      id: 'srq-1',
      source: 'hermes',
      conversationId: 's1',
      kind: 'secret',
      secret: { input: 'login' },
      title: 'Save a login for github.com',
      detail: 'https://github.com',
      options: [{ id: SECRET_DECLINE, label: 'Decline', kind: 'deny' }],
      createdAt: 5,
    });
    expect(secretApproval('srq-2', 's1', 'vault.save_login', { origin: 'https://github.com' }, 0)!.title).toBe(
      'Save a login for https://github.com',
    );
    const unnamed = secretApproval('srq-3', 's1', 'vault.save_login', {}, 0)!;
    expect(unnamed.title).toBe('Save a login');
    expect(unnamed.detail).toBeUndefined();
  });

  it('makes no card for requests that are not password prompts', () => {
    expect(secretApproval('a', 's1', 'preview.read', {}, 0)).toBeNull();
    expect(secretApproval('b', 's1', 'clarify', { question: 'Which?' }, 0)).toBeNull();
  });

  it('shows a long command in full, and flags one too long to send', () => {
    const long = `sudo ${'a'.repeat(70_000)}`;
    const card = secretApproval('a', 's1', 'sudo', { command: long }, 0)!;
    expect(card.detailTruncated).toBe(true);
    expect(card.detail!.startsWith(long.slice(0, 60_000))).toBe(true);
    expect(secretApproval('b', 's1', 'sudo', { command: 'a'.repeat(60_000) }, 0)!.detailTruncated).toBeUndefined();
  });

  it('takes the typed value exactly as typed, or the decline, and nothing else', () => {
    expect(secretAnswer('password', { text: ' pass word ' })).toEqual({ value: ' pass word ' });
    expect(secretAnswer('code', { text: 'x'.repeat(MAX_SECRET_CHARS) })).toEqual({ value: 'x'.repeat(MAX_SECRET_CHARS) });
    expect(secretAnswer('password', { optionId: SECRET_DECLINE })).toEqual({ value: '' });
    const refused: ApprovalAnswer[] = [
      {},
      { text: '' },
      { text: ' \n ' },
      { text: `${MARKER}${'x'.repeat(MAX_SECRET_CHARS)}` },
      { optionId: SECRET_DECLINE, text: MARKER },
      { optionId: 'once' },
      { optionIds: [SECRET_DECLINE] },
      { optionIds: ['0'], text: MARKER },
      { login: { identifier: LOGIN_ID, password: LOGIN_PW } },
      { text: MARKER, login: { identifier: LOGIN_ID, password: LOGIN_PW } },
    ];
    for (const answer of refused) {
      const result = secretAnswer('password', answer);
      expect(result).toHaveProperty('problem');
      expectNoMarkers([JSON.stringify(result)]);
    }
  });

  it('takes a login as the JSON Hermes wants, exactly as typed, or the decline', () => {
    const login = { identifier: ` ${LOGIN_ID} `, password: ` ${LOGIN_PW} ` };
    const sent = secretAnswer('login', { login });
    expect(sent).toEqual({ value: JSON.stringify({ identifier: login.identifier, password: login.password }) });
    expect(JSON.parse((sent as { value: string }).value)).toEqual(login);
    expect(secretAnswer('login', { optionId: SECRET_DECLINE })).toEqual({ value: '' });
    const most = 'x'.repeat(MAX_SECRET_CHARS);
    expect(secretAnswer('login', { login: { identifier: most, password: most } })).toHaveProperty('value');

    const plain = { identifier: LOGIN_ID, password: LOGIN_PW };
    const refused: ApprovalAnswer[] = [
      {},
      { text: LOGIN_PW },
      { login: plain, text: LOGIN_PW },
      { login: plain, optionId: SECRET_DECLINE },
      { login: plain, optionIds: ['0'] },
      { optionId: 'once' },
      { optionIds: [SECRET_DECLINE] },
      { login: { identifier: '', password: LOGIN_PW } },
      { login: { identifier: ' \n', password: LOGIN_PW } },
      { login: { identifier: LOGIN_ID, password: '' } },
      { login: { identifier: LOGIN_ID, password: '   ' } },
      { login: { identifier: `${most}${LOGIN_ID}`, password: LOGIN_PW } },
      { login: { identifier: LOGIN_ID, password: `${most}${LOGIN_PW}` } },
    ];
    for (const answer of refused) {
      const result = secretAnswer('login', answer);
      expect(result).toHaveProperty('problem');
      expectNoMarkers([JSON.stringify(result)]);
    }
  });
});

describe('hermes secret prompts against the fake dashboard', () => {
  let fake: FakeHermes;
  let hub: EventHub;
  let published: ServerEvent[];
  let stateDir: string;
  let adapter: HermesAdapter | undefined;

  beforeEach(async () => {
    fake = new FakeHermes();
    await fake.start();
    hub = new EventHub();
    published = recordPublished(hub);
    stateDir = mkdtempSync(join(tmpdir(), 'sb-secrets-'));
    new SecretStore(stateDir).writeHermes(FAKE_USER);
  });

  afterEach(async () => {
    adapter?.stop();
    adapter = undefined;
    await fake.stop();
  });

  async function connect(secretPrompts: boolean): Promise<HermesAdapter> {
    const connected = new HermesAdapter(fake.url, hub, new SecretStore(stateDir), quietLog, { background: new BackgroundGate('primary'), secretPrompts });
    adapter = connected;
    connected.start();
    await expect.poll(() => connected.status().state).toBe('connected');
    await connected.getConversation(STORED); // attaches, like opening the chat
    return connected;
  }

  const notices = () =>
    published
      .flatMap((e): TimelineItem[] => (e.type === 'items_upsert' ? e.items : []))
      .filter((i): i is Extract<TimelineItem, { kind: 'notice' }> => i.kind === 'notice');
  const removed = (approvalId: string): ServerEvent => ({ type: 'approval_removed', source: 'hermes', conversationId: STORED, approvalId });

  /** Answer that must be refused: returns the status, and checks the error repeats nothing sent. */
  const refusal = async (hermes: HermesAdapter, conversationId: string, approvalId: string, answer: ApprovalAnswer) => {
    const err = await hermes.respondToApproval(conversationId, approvalId, answer).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserFacingError);
    expectNoMarkers([(err as UserFacingError).message]);
    return (err as UserFacingError).status;
  };

  it('only shows a notice while the switch is off, as it is by default', async () => {
    const hermes = await connect(false);
    PROMPTS.forEach(([method, params], i) => fake.serverRequest(`srq-${i}`, method, params));
    await expect.poll(() => notices().length).toBe(PROMPTS.length);
    expect(notices()).toEqual(PROMPTS.map((_, i) => ({ kind: 'notice', id: `req-srq-${i}`, level: 'info', text: NOTICE })));
    expect(hermes.listApprovals()).toEqual([]);
    expect(published.some((e) => e.type === 'approval_upsert')).toBe(false);
    expect(fake.responses).toEqual([]);
    expect(fake.calls.some((c) => c.method === 'request.answer')).toBe(false);
  });

  it('turns all five into secret cards when switched on', async () => {
    const hermes = await connect(true);
    for (const [method, params] of PROMPTS) fake.serverRequest(`srq-${method}`, method, params);
    await expect.poll(() => hermes.listApprovals().length).toBe(5);
    expect(notices()).toEqual([]);

    const cards = hermes.listApprovals();
    expect(cards.map((c) => c.id)).toEqual(PROMPTS.map(([method]) => `srq-${method}`));
    expect(cards.every((c) => c.kind === 'secret' && c.conversationId === STORED)).toBe(true);
    expect(cards.every((c) => c.options.length === 1 && c.options[0]!.id === SECRET_DECLINE)).toBe(true);
    expect(cards[0]).toMatchObject({
      title: 'Hermes asks for your sudo password',
      detail: 'apt install ripgrep',
      secret: { input: 'password', confirm: true },
    });
    expect(cards[1]).toMatchObject({ title: 'Hermes asks for OPENAI_API_KEY', detail: 'Enter your OpenAI API key' });
    expect(cards[2]).toMatchObject({ title: 'Vault master password for 1Password' });
    expect(cards[3]).toMatchObject({ title: 'Save a login for github.com', detail: 'https://github.com', secret: { input: 'login' } });
    expect(cards[4]).toMatchObject({ title: '2FA code for github.com', secret: { input: 'code' } });
    expect(published.filter((e) => e.type === 'approval_upsert')).toEqual(cards.map((approval) => ({ type: 'approval_upsert', approval })));
    const [summary] = await hermes.listConversations();
    expect(summary).toMatchObject({ status: 'needs_approval', pendingApprovals: 5 });

    // Hermes re-sends open requests after a reconnect; they don't pile up.
    fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install ripgrep' });
    fake.serverRequest('srq-fence', 'vault.code', { site: 'example.com' });
    await expect.poll(() => hermes.listApprovals().length).toBe(6);
    expect(hermes.listApprovals().filter((c) => c.id === 'srq-sudo')).toHaveLength(1);
    expect(fake.responses).toEqual([]);
  });

  it('sends the value as typed, as { value }, on the connection the request came on', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install ripgrep' });
    await expect.poll(() => hermes.listApprovals().length).toBe(1);

    await hermes.respondToApproval(STORED, 'srq-sudo', { text: ' correct horse ' });
    await expect.poll(() => fake.responses).toEqual([{ id: 'srq-sudo', result: { value: ' correct horse ' } }]);
    expect(fake.calls.some((c) => c.method === 'request.answer')).toBe(false);
    expect(hermes.listApprovals()).toEqual([]);
    expect(published).toContainEqual(removed('srq-sudo'));
  });

  it('saves a login as the JSON Hermes wants, exactly as typed', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-save', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' });
    await expect.poll(() => hermes.listApprovals().length).toBe(1);

    const login = { identifier: ` ${LOGIN_ID} `, password: ` ${LOGIN_PW} ` };
    await hermes.respondToApproval(STORED, 'srq-save', { login });
    await expect.poll(() => fake.responses).toEqual([
      { id: 'srq-save', result: { value: `{"identifier":" ${LOGIN_ID} ","password":" ${LOGIN_PW} "}` } },
    ]);
    expect(hermes.listApprovals()).toEqual([]);
    expect(published).toContainEqual(removed('srq-save'));
  });

  it('answers a request from a resume snapshot with request.answer', async () => {
    fake.openRequests = [
      { id: 'srq-code', method: 'vault.code', params: { site: 'github.com', hint: '' } },
      { id: 'srq-save', method: 'vault.save_login', params: { origin: 'https://github.com', site: 'github.com' } },
    ];
    const hermes = await connect(true);
    expect(hermes.listApprovals()).toMatchObject([
      { id: 'srq-code', kind: 'secret', secret: { input: 'code' } },
      { id: 'srq-save', kind: 'secret', secret: { input: 'login' } },
    ]);

    await hermes.respondToApproval(STORED, 'srq-code', { text: '123 456' });
    await hermes.respondToApproval(STORED, 'srq-save', { login: { identifier: LOGIN_ID, password: LOGIN_PW } });
    expect(fake.calls.filter((c) => c.method === 'request.answer').map((c) => c.params)).toEqual([
      { id: 'srq-code', result: { value: '123 456' } },
      { id: 'srq-save', result: { value: JSON.stringify({ identifier: LOGIN_ID, password: LOGIN_PW }) } },
    ]);
    expect(fake.responses).toEqual([]);
    expect(hermes.listApprovals()).toEqual([]);
  });

  it('declines with an empty value, which Hermes treats as a refusal', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-vault', 'vault.unlock_prompt', { backend: 'onepassword', display_name: '1Password' });
    fake.serverRequest('srq-save', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' });
    await expect.poll(() => hermes.listApprovals().length).toBe(2);

    await hermes.respondToApproval(STORED, 'srq-vault', { optionId: SECRET_DECLINE });
    await hermes.respondToApproval(STORED, 'srq-save', { optionId: SECRET_DECLINE });
    await expect.poll(() => fake.responses).toEqual([
      { id: 'srq-vault', result: { value: '' } },
      { id: 'srq-save', result: { value: '' } },
    ]);
    expect(hermes.listApprovals()).toEqual([]);
    expect(published).toContainEqual(removed('srq-vault'));
    expect(published).toContainEqual(removed('srq-save'));
  });

  it('refuses another chat, an unknown card, and anything but a value or the decline', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install ripgrep' });
    await expect.poll(() => hermes.listApprovals().length).toBe(1);

    expect(await refusal(hermes, '20260101_000000_other', 'srq-sudo', { text: MARKER })).toBe(409);
    expect(await refusal(hermes, STORED, 'srq-guess', { text: MARKER })).toBe(409);
    const bad: ApprovalAnswer[] = [
      { text: '' },
      { text: '   ' },
      { text: MARKER.repeat(500) },
      { optionId: 'once' },
      { optionIds: [SECRET_DECLINE] },
      { optionId: SECRET_DECLINE, text: MARKER },
      { login: { identifier: LOGIN_ID, password: LOGIN_PW } },
    ];
    for (const answer of bad) expect(await refusal(hermes, STORED, 'srq-sudo', answer)).toBe(400);
    expect(fake.responses).toEqual([]);
    expect(fake.calls.some((c) => c.method === 'request.answer')).toBe(false);
    expect(hermes.listApprovals().map((c) => c.id)).toEqual(['srq-sudo']);

    await hermes.respondToApproval(STORED, 'srq-sudo', { text: MARKER });
    await expect.poll(() => fake.responses).toEqual([{ id: 'srq-sudo', result: { value: MARKER } }]);
  });

  it('refuses a login in any other shape, for another chat, or on any other card', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-save', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' });
    fake.serverRequest('srq-perm', 'approval', {
      command: 'rm -rf build',
      description: 'delete the build folder',
      request_id: 'q-1',
      choices: ['once', 'deny'],
    });
    fake.serverRequest('srq-ask', 'clarify', { question: 'Which branch?', choices: ['main', 'dev'] });
    await expect.poll(() => hermes.listApprovals().length).toBe(3);

    const login = { identifier: LOGIN_ID, password: LOGIN_PW };
    const most = 'x'.repeat(MAX_SECRET_CHARS);
    const wrong: ApprovalAnswer[] = [
      { text: LOGIN_PW },
      { login, text: LOGIN_PW },
      { login, optionId: SECRET_DECLINE },
      { login, optionIds: ['0'] },
      { optionIds: [SECRET_DECLINE] },
      { login: { identifier: '', password: LOGIN_PW } },
      { login: { identifier: LOGIN_ID, password: ' ' } },
      { login: { identifier: `${most}${LOGIN_ID}`, password: LOGIN_PW } },
      { login: { identifier: LOGIN_ID, password: `${most}${LOGIN_PW}` } },
    ];
    for (const answer of wrong) expect(await refusal(hermes, STORED, 'srq-save', answer)).toBe(400);
    expect(await refusal(hermes, '20260101_000000_other', 'srq-save', { login })).toBe(409);
    // A username and password never answer a permission or a question.
    expect(await refusal(hermes, STORED, 'srq-perm', { optionId: 'once', login })).toBe(400);
    expect(await refusal(hermes, STORED, 'srq-ask', { text: 'main', login })).toBe(400);
    expect(fake.responses).toEqual([]);
    expect(hermes.listApprovals()).toHaveLength(3);

    await hermes.respondToApproval(STORED, 'srq-save', { login });
    await expect.poll(() => fake.responses).toEqual([{ id: 'srq-save', result: { value: JSON.stringify(login) } }]);
  });

  it('only lets you decline when the command was too long to show in full', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-long', 'sudo', { command: `sudo ${'a'.repeat(70_000)}` });
    await expect.poll(() => hermes.listApprovals().length).toBe(1);
    expect(hermes.listApprovals()[0]!.detailTruncated).toBe(true);

    await expect(hermes.respondToApproval(STORED, 'srq-long', { text: MARKER })).rejects.toMatchObject({ status: 400 });
    expect(hermes.listApprovals()).toHaveLength(1);
    await hermes.respondToApproval(STORED, 'srq-long', { optionId: SECRET_DECLINE });
    await expect.poll(() => fake.responses).toEqual([{ id: 'srq-long', result: { value: '' } }]);
  });

  it('clears the card when Hermes withdraws the request or it times out', async () => {
    const hermes = await connect(true);
    fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install ripgrep' });
    fake.serverRequest('srq-code', 'vault.code', { site: 'github.com', hint: '' });
    fake.serverRequest('srq-save', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' });
    await expect.poll(() => hermes.listApprovals().length).toBe(3);

    fake.event('request.cancel', { id: 'srq-sudo', method: 'sudo', reason: 'timeout' });
    fake.event('request.cancel', { id: 'srq-code', method: 'vault.code', reason: 'interrupted' });
    fake.event('request.cancel', { id: 'srq-save', method: 'vault.save_login', reason: 'timeout' });
    await expect.poll(() => hermes.listApprovals()).toEqual([]);
    expect(published).toContainEqual(removed('srq-sudo'));
    expect(published).toContainEqual(removed('srq-code'));
    expect(published).toContainEqual(removed('srq-save'));
    expect((await hermes.listConversations())[0]).toMatchObject({ pendingApprovals: 0 });

    await expect(hermes.respondToApproval(STORED, 'srq-sudo', { text: 'too late' })).rejects.toMatchObject({ status: 409 });
    expect(fake.responses).toEqual([]);
  });

  it("drops a card Hermes says expired, and never repeats Hermes' error text", async () => {
    fake.openRequests = [
      { id: 'srq-a', method: 'sudo', params: { command: 'apt install ripgrep' } },
      { id: 'srq-b', method: 'secret', params: { env_var: 'OPENAI_API_KEY', prompt: 'Enter your OpenAI API key' } },
      { id: 'srq-c', method: 'vault.save_login', params: { origin: 'https://github.com', site: 'github.com' } },
    ];
    const hermes = await connect(true);
    expect(hermes.listApprovals().map((c) => c.id)).toEqual(['srq-a', 'srq-b', 'srq-c']);

    // An error that quotes what it was sent must not reach the phone.
    fake.handlers['request.answer'] = (params) => ({ error: { code: 4002, message: `rejected ${JSON.stringify(params)}` } });
    for (const [id, answer] of [
      ['srq-b', { text: MARKER }],
      ['srq-c', { login: { identifier: LOGIN_ID, password: LOGIN_PW } }],
    ] as Array<[string, ApprovalAnswer]>) {
      const failed = await hermes.respondToApproval(STORED, id, answer).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failed).toBeInstanceOf(UserFacingError);
      expectNoMarkers([(failed as Error).message]);
      expect((failed as Error).message).not.toContain('rejected');
    }
    expect(hermes.listApprovals()).toHaveLength(3); // still waiting: try again

    fake.handlers['request.answer'] = () => ({ status: 'expired' });
    await expect(hermes.respondToApproval(STORED, 'srq-a', { text: MARKER })).rejects.toMatchObject({
      status: 410,
      message: 'That request already expired.',
    });
    expect(hermes.listApprovals().map((c) => c.id)).toEqual(['srq-b', 'srq-c']);
    expect(published).toContainEqual(removed('srq-a'));
  });
});

describe('answering a secret card through the API', () => {
  let keys: Keys;
  let token: string;

  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  /** The real route and adapter against the fake dashboard, with everything they output captured. */
  async function startApi() {
    const fake = new FakeHermes();
    await fake.start();
    const config = makeConfig();
    new SecretStore(config.stateDir).writeHermes(FAKE_USER);

    const hub = new EventHub();
    const published = recordPublished(hub);
    const sent: string[] = [];
    const socket = { readyState: 1, bufferedAmount: 0, send: (payload: string) => void sent.push(payload), terminate() {} };
    hub.subscribe(hub.add(socket as never, EMAIL), 'hermes', STORED);

    const adapterLogs: string[] = [];
    const capture = (level: string) => (obj: object, msg?: string) => void adapterLogs.push(JSON.stringify({ level, msg, ...obj }));
    const log: Logger = { info: capture('info'), warn: capture('warn'), error: capture('error') };
    const adapter = new HermesAdapter(fake.url, hub, new SecretStore(config.stateDir), log, { background: new BackgroundGate('primary'), secretPrompts: true });

    // Everything Fastify would log, at its most verbose level.
    const serverLogs: string[] = [];
    const app = await buildApp({
      config,
      hub,
      verifier: createAccessVerifier({ ...config.access!, keySource: keys.keySource }),
      sources: { hermes: adapter, paseo: new FakePaseo() },
      logger: { level: 'trace', stream: { write: (line: string) => void serverLogs.push(line) } },
    });
    adapter.start();
    await expect.poll(() => adapter.status().state).toBe('connected');
    await adapter.getConversation(STORED);

    const post = (approvalId: string, payload: string, headers = postHeaders(token), conversationId = STORED) =>
      app.inject({ method: 'POST', url: `/api/conversations/hermes/${conversationId}/approvals/${approvalId}`, headers, payload });

    /**
     * The captures caught something (denials are logged, the card went out,
     * the sign-in was saved), request logging stayed off, and no marker is in
     * any response, event, log, card or state file.
     */
    const expectKeptNowhere = (responses: string[]) => {
      expect(serverLogs.some((line) => line.includes('request denied'))).toBe(true);
      expect(serverLogs.some((line) => /incoming request|request completed|request errored/.test(line))).toBe(false);
      expect(sent.some((payload) => payload.includes('"approval_upsert"'))).toBe(true);
      const stateFiles = filesUnder(config.stateDir);
      expect(stateFiles.length).toBeGreaterThan(0);
      expectNoMarkers([
        ...responses,
        ...published.map((event) => JSON.stringify(event)),
        ...sent,
        ...adapterLogs,
        ...serverLogs,
        JSON.stringify(adapter.listApprovals()),
        ...stateFiles,
      ]);
    };

    const stop = async () => {
      adapter.stop();
      await app.close();
      await fake.stop();
    };
    return { fake, adapter, published, post, expectKeptNowhere, stop };
  }

  const body = (answer: unknown) => JSON.stringify(answer);
  const withoutToken = () => {
    const { 'cf-access-jwt-assertion': _token, ...headers } = postHeaders(token);
    return headers;
  };
  const withoutOrigin = () => {
    const { origin: _origin, ...headers } = postHeaders(token);
    return headers;
  };

  it('passes a password to Hermes and nowhere else, whatever goes wrong first', async () => {
    const api = await startApi();
    try {
      api.fake.serverRequest('srq-sudo', 'sudo', { command: 'apt install ripgrep' });
      await expect.poll(() => api.adapter.listApprovals().length).toBe(1);

      const attempts: Array<[number, { statusCode: number; body: string }]> = [
        [401, await api.post('srq-sudo', body({ text: MARKER }), withoutToken())],
        [403, await api.post('srq-sudo', body({ text: MARKER }), withoutOrigin())],
        [403, await api.post('srq-sudo', body({ text: MARKER }), postHeaders(token, { 'content-type': 'text/plain' }))],
        [400, await api.post('srq-sudo', body({ text: MARKER, remember: true }))],
        [400, await api.post('srq-sudo', body({ text: [MARKER] }))],
        [400, await api.post('srq-sudo', `{"text":"${MARKER}"`)],
        [400, await api.post('srq-sudo', body({ text: `${MARKER}${'x'.repeat(MAX_SECRET_CHARS)}` }))],
        [400, await api.post('srq-sudo', body({ optionId: SECRET_DECLINE, text: MARKER }))],
        [413, await api.post('srq-sudo', body({ text: `${MARKER}${'x'.repeat(300_000)}` }))],
        [409, await api.post('srq-sudo', body({ text: MARKER }), postHeaders(token), '20260101_000000_other')],
        [409, await api.post('srq-guess', body({ text: MARKER }))],
      ];
      for (const [status, res] of attempts) expect(res.statusCode).toBe(status);
      expect(api.fake.responses).toEqual([]);
      expect(api.fake.calls.some((c) => c.method === 'request.answer')).toBe(false);
      expect(api.adapter.listApprovals()).toHaveLength(1);

      const ok = await api.post('srq-sudo', body({ text: MARKER }));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      await expect.poll(() => api.fake.responses).toEqual([{ id: 'srq-sudo', result: { value: MARKER } }]);
      expect(api.adapter.listApprovals()).toEqual([]);
      expect(api.published).toContainEqual({ type: 'approval_removed', source: 'hermes', conversationId: STORED, approvalId: 'srq-sudo' });
      api.expectKeptNowhere([...attempts.map(([, res]) => res.body), ok.body]);
    } finally {
      await api.stop();
    }
  });

  it('passes a login to Hermes as one JSON value and nowhere else, whatever goes wrong first', async () => {
    const api = await startApi();
    try {
      api.fake.serverRequest('srq-save', 'vault.save_login', { origin: 'https://github.com', site: 'github.com' });
      await expect.poll(() => api.adapter.listApprovals().length).toBe(1);

      const login = { identifier: LOGIN_ID, password: LOGIN_PW };
      const most = 'x'.repeat(MAX_SECRET_CHARS);
      const attempts: Array<[number, { statusCode: number; body: string }]> = [
        [401, await api.post('srq-save', body({ login }), withoutToken())],
        [403, await api.post('srq-save', body({ login }), withoutOrigin())],
        [400, await api.post('srq-save', body({ login: { ...login, remember: true } }))],
        [400, await api.post('srq-save', body({ login, remember: true }))],
        [400, await api.post('srq-save', body({ login: { identifier: LOGIN_ID } }))],
        [400, await api.post('srq-save', body({ login: `${LOGIN_ID}:${LOGIN_PW}` }))],
        [400, await api.post('srq-save', body({ login: { identifier: LOGIN_ID, password: [LOGIN_PW] } }))],
        [400, await api.post('srq-save', `{"login":{"identifier":"${LOGIN_ID}","password":"${LOGIN_PW}"}`)],
        [400, await api.post('srq-save', body({ login, text: LOGIN_PW }))],
        [400, await api.post('srq-save', body({ login, optionId: SECRET_DECLINE }))],
        [400, await api.post('srq-save', body({ text: `${LOGIN_ID} ${LOGIN_PW}` }))],
        [400, await api.post('srq-save', body({ login: { identifier: LOGIN_ID, password: '  ' } }))],
        [400, await api.post('srq-save', body({ login: { identifier: `${most}${LOGIN_ID}`, password: LOGIN_PW } }))],
        [400, await api.post('srq-save', body({ login: { identifier: LOGIN_ID, password: `${most}${LOGIN_PW}` } }))],
        [409, await api.post('srq-save', body({ login }), postHeaders(token), '20260101_000000_other')],
        [409, await api.post('srq-guess', body({ login }))],
      ];
      for (const [status, res] of attempts) expect(res.statusCode).toBe(status);
      expect(api.fake.responses).toEqual([]);
      expect(api.fake.calls.some((c) => c.method === 'request.answer')).toBe(false);
      expect(api.adapter.listApprovals()).toHaveLength(1);

      const ok = await api.post('srq-save', body({ login }));
      expect(ok.statusCode).toBe(200);
      await expect.poll(() => api.fake.responses).toEqual([
        { id: 'srq-save', result: { value: `{"identifier":"${LOGIN_ID}","password":"${LOGIN_PW}"}` } },
      ]);
      expect(api.adapter.listApprovals()).toEqual([]);
      api.expectKeptNowhere([...attempts.map(([, res]) => res.body), ok.body]);
    } finally {
      await api.stop();
    }
  });

  it('refuses a login meant for a backend that never asks for one', async () => {
    const { app, paseo } = await makeApp(keys);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/conversations/paseo/p1/approvals/a1',
        headers: postHeaders(token),
        payload: body({ optionId: 'allow', login: { identifier: LOGIN_ID, password: LOGIN_PW } }),
      });
      expect(res.statusCode).toBe(400);
      expectNoMarkers([res.body]);
      expect(paseo.calls).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
