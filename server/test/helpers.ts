import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';
import type {
  Approval,
  ApprovalAnswer,
  ArchivedThread,
  CloudAgent,
  CloudAgentId,
  CloudAgentsStatus,
  CommandResult,
  ConversationDetail,
  ConversationSummary,
  FolderScope,
  FolderStatus,
  PaseoOptions,
  SlashCommand,
  HermesOptions,
  Source,
  SourceStatus,
  ThreadActionResult,
  TimelineItem,
} from '../../shared/protocol.js';
import { buildApp, type AppDeps } from '../src/app.js';
import type { Attachment } from '../src/attachments.js';
import { parseConfig, type AppConfig } from '../src/config.js';
import type { Connectors } from '../src/connectors/service.js';
import type { SpeechService } from '../src/speech.js';
import type { Feed } from '../src/feed/service.js';
import { Devices } from '../src/devices.js';
import { EventHub } from '../src/hub.js';
import type { Notifications } from '../src/notifications/service.js';
import type { PowerOptions } from '../src/power.js';
import type { SupervisorApi } from '../src/supervisor-client.js';
import { createAccessVerifier } from '../src/security/access.js';
import type { CreatePaseoAgentInput, HermesSource, PaseoSource } from '../src/sources.js';

export const ISSUER = 'https://testteam.cloudflareaccess.com';
export const AUD = 'test-aud-0123456789abcdef';
export const EMAIL = 'owner@example.com';
export const ORIGIN = 'https://wayroost.example.com';

/** Obviously fake paired devices every test app starts with (see seedDevices). */
export const TEST_DESKTOP = { id: `dv_${'0'.repeat(23)}1`, secret: `desktop_test_secret_${'d'.repeat(23)}` };
export const TEST_PHONE = { id: `dv_${'0'.repeat(23)}2`, secret: `phone_test_secret_${'p'.repeat(25)}` };
export const DESKTOP_COOKIE = `wr_device=${TEST_DESKTOP.id}.${TEST_DESKTOP.secret}`;
export const PHONE_COOKIE = `wr_device=${TEST_PHONE.id}.${TEST_PHONE.secret}`;

/** Writes devices.json with the test desktop and phone, as if both had paired. */
export function seedDevices(stateDir: string): void {
  const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
  const at = 1_700_000_000_000;
  const devices = [
    { ...TEST_DESKTOP, name: 'Test desktop', kind: 'desktop', scopes: [] },
    { ...TEST_PHONE, name: 'Test phone', kind: 'phone', scopes: [] },
  ].map(({ secret, ...d }) => ({ ...d, created: at, lastSeen: at, secretHash: hash(secret) }));
  writeFileSync(join(stateDir, 'devices.json'), JSON.stringify({ version: 1, devices }), { mode: 0o600 });
}

export interface Keys {
  privateKey: CryptoKey;
  otherPrivateKey: CryptoKey;
  kid: string;
  keySource: ReturnType<typeof createLocalJWKSet>;
}

export async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const kid = 'test-key';
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, otherPrivateKey: other.privateKey, kid, keySource: createLocalJWKSet({ keys: [jwk] }) };
}

export async function makeToken(
  keys: Keys,
  overrides: {
    claims?: JWTPayload;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string | number;
    key?: CryptoKey;
    kid?: string;
  } = {},
): Promise<string> {
  const claims = overrides.claims ?? { email: EMAIL, type: 'app' };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? keys.kid })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? [AUD])
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(overrides.key ?? keys.privateKey);
}

/** A config with Access and device sign-in, its state directory seeded with the test devices. */
export function makeConfig(staticDir?: string, extra: Record<string, unknown> = {}): AppConfig {
  const stateDir = mkdtempSync(join(tmpdir(), 'sb-state-'));
  seedDevices(stateDir);
  return parseConfig({
    rollout: { settingsPages: true, revokes: true, chatFirst: true },
    publicOrigin: ORIGIN,
    access: { teamDomain: ISSUER, aud: AUD, allowedEmails: [EMAIL] },
    stateDir,
    ...(staticDir ? { staticDir } : {}),
    ...extra,
  });
}

export function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Wayroost</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Wayroost"}');
  return dir;
}

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const summary = (source: 'hermes' | 'paseo', id: string): ConversationSummary => ({
  source,
  id,
  title: `${source} ${id}`,
  status: 'idle',
  updatedAt: 1_700_000_000_000,
  pendingApprovals: 0,
});

/** Archive/restore/delete that record their calls; an id containing "broken" fails. */
class FakeTidying {
  calls: string[] = [];
  archivedRows: ArchivedThread[] = [];
  idle: string[] = [];
  idleBefore: number[] = [];
  constructor(private readonly source: Source) {}
  private run(action: string, ids: string[], extra = ''): ThreadActionResult {
    this.calls.push(`${action}:${ids.join(',')}${extra}`);
    const failed = ids.filter((id) => id.includes('broken')).map((id) => ({ source: this.source, id, error: 'it broke' }));
    return { done: ids.length - failed.length, failed };
  }
  async archiveThreads(ids: string[], folder?: FolderScope) {
    return this.run('archive', ids, folder ? `@${folder.path}|${folder.paseoRoots.join(',')}` : '');
  }
  async restoreThreads(ids: string[]) {
    return this.run('restore', ids);
  }
  async deleteThreads(ids: string[]) {
    return this.run('delete', ids);
  }
  async listArchived() {
    return this.archivedRows;
  }
  async idleThreads(before: number) {
    this.idleBefore.push(before);
    return this.idle;
  }
}

export class FakeHermes implements HermesSource {
  readonly tidying = new FakeTidying('hermes');
  archiveThreads = (ids: string[], folder?: FolderScope) => this.tidying.archiveThreads(ids, folder);
  restoreThreads = (ids: string[]) => this.tidying.restoreThreads(ids);
  deleteThreads = (ids: string[]) => this.tidying.deleteThreads(ids);
  listArchived = () => this.tidying.listArchived();
  idleThreads = (before: number) => this.tidying.idleThreads(before);
  calls: string[] = [];
  status(): SourceStatus {
    return { source: 'hermes', state: 'connected' };
  }
  async listConversations() {
    return [summary('hermes', 'h1')];
  }
  listApprovals(): Approval[] {
    return [];
  }
  async getConversation(id: string): Promise<ConversationDetail> {
    const items: TimelineItem[] =
      id === 'with-image' ? [{ kind: 'assistant', id: 'a1', text: 'Here it is: ![garden](/home/me/Pictures/garden.png)' }] : [];
    return { conversation: summary('hermes', id), items, approvals: [] };
  }
  async readImage(id: string, path: string) {
    this.calls.push(`image:${id}:${path}`);
    return { bytes: path.includes('garden') ? PNG_BYTES : Buffer.from('#!/bin/sh\necho not an image\n') };
  }
  async sendMessage(id: string, text: string, attachments?: Attachment[]): Promise<CommandResult | void> {
    this.calls.push(`send:${id}:${text}${attachments?.length ? `:+${attachments.map((a) => a.name).join(',')}` : ''}`);
    if (text.startsWith('/status')) {
      return { items: [{ kind: 'command', id: 'cmd-1', command: '/status', output: 'all good' }] };
    }
  }
  async interrupt(id: string) {
    this.calls.push(`interrupt:${id}`);
  }
  async respondToApproval(conversationId: string, approvalId: string, answer: ApprovalAnswer) {
    this.calls.push(`approve:${conversationId}:${approvalId}:${answer.optionId ?? answer.text}`);
  }
  async listCommands(id: string): Promise<SlashCommand[]> {
    this.calls.push(`commands:${id}`);
    return [{ name: 'status', kind: 'command', description: 'Show session info' }];
  }
  async listNewChatCommands(): Promise<SlashCommand[]> {
    this.calls.push('commands:new');
    return [{ name: 'plan', kind: 'skill' }];
  }
  /** What Hermes says about the folder a new chat started in (it keeps only one that exists). */
  createNotice: string | undefined;
  async createConversation(text: string, _cwd?: string, _attachments?: unknown, options?: { model?: string; confirmModel?: boolean }) {
    this.calls.push(`create:${text}`);
    if (options?.model) this.calls.push(`create-model:${options.model}${options.confirmModel ? ':confirmed' : ''}`);
    return { id: 'new-hermes', ...(this.createNotice ? { notice: this.createNotice } : {}) };
  }
  async newChatOptions(): Promise<HermesOptions> {
    this.calls.push('options');
    return { models: [{ id: '["local","main-model"]', label: 'main-model', group: 'Local' }], defaultModel: '["local","main-model"]' };
  }
  async setCredentials(username: string) {
    this.calls.push(`creds:${username}`);
    return this.status();
  }
  async clearCredentials() {
    this.calls.push('clear');
    return this.status();
  }
}

export class FakePaseo implements PaseoSource {
  readonly tidying = new FakeTidying('paseo');
  archiveThreads = (ids: string[]) => this.tidying.archiveThreads(ids);
  restoreThreads = (ids: string[]) => this.tidying.restoreThreads(ids);
  deleteThreads = (ids: string[]) => this.tidying.deleteThreads(ids);
  listArchived = () => this.tidying.listArchived();
  idleThreads = (before: number) => this.tidying.idleThreads(before);
  calls: string[] = [];
  status(): SourceStatus {
    return { source: 'paseo', state: 'connected' };
  }
  async listConversations() {
    return [summary('paseo', 'p1')];
  }
  listApprovals(): Approval[] {
    return [];
  }
  async getConversation(id: string): Promise<ConversationDetail> {
    return { conversation: summary('paseo', id), items: [], approvals: [] };
  }
  async sendMessage(id: string, text: string) {
    this.calls.push(`send:${id}:${text}`);
  }
  async interrupt(id: string) {
    this.calls.push(`interrupt:${id}`);
  }
  async respondToApproval(conversationId: string, approvalId: string, answer: ApprovalAnswer) {
    this.calls.push(`approve:${conversationId}:${approvalId}:${answer.optionId ?? answer.text}`);
  }
  async listCommands(id: string): Promise<SlashCommand[]> {
    this.calls.push(`commands:${id}`);
    return [];
  }
  async options(): Promise<PaseoOptions> {
    return { providers: [], workspaces: [] };
  }
  async createConversation(input: CreatePaseoAgentInput) {
    this.calls.push(`create:${input.providerId}:${input.cwd}`);
    return 'new-paseo';
  }
  /** Folders that exist, as the Paseo daemon sees them. */
  folders = new Set(['/', '/home', '/home/me', '/home/me/code']);
  async folderStatus(path: string): Promise<FolderStatus> {
    this.calls.push(`folder:${path}`);
    if (this.folders.has(path)) return 'exists';
    return this.folders.has(path.slice(0, path.lastIndexOf('/')) || '/') ? 'missing' : 'missing-parent';
  }
  async createFolder(path: string) {
    this.calls.push(`mkdir:${path}`);
    this.folders.add(path);
    return path;
  }
  cloud: CloudAgent[] = [
    { id: 'claude', label: 'Claude Code', enabled: true, state: 'ready' },
    { id: 'codex', label: 'Codex', enabled: true, state: 'ready' },
  ];
  async cloudAgents(): Promise<CloudAgentsStatus> {
    return { agents: this.cloud };
  }
  async setCloudAgentEnabled(id: CloudAgentId, enabled: boolean): Promise<CloudAgentsStatus> {
    this.calls.push(`cloud:${id}:${enabled}`);
    this.cloud = this.cloud.map((a): CloudAgent => (a.id === id ? { ...a, enabled, state: enabled ? 'ready' : 'off' } : a));
    return { agents: this.cloud };
  }
}

export async function makeApp(
  keys: Keys,
  options: {
    staticDir?: string;
    wsMaxLifetimeMs?: number;
    connectors?: Connectors;
    speech?: SpeechService;
    cloudSpeech?: AppDeps['cloudSpeech'];
    whatsappRouting?: AppDeps['whatsappRouting'];
    phone?: AppDeps['phone'];
    schedules?: AppDeps['schedules'];
    /** Builds For you from this app's hub and fake Hermes. */
    feed?: (deps: { hub: EventHub; hermes: FakeHermes; stateDir: string }) => Feed;
    /** Alerts: the routing service, built from this app's hub and state folder. */
    notifications?: (deps: { hub: EventHub; stateDir: string }) => Notifications;
    skills?: AppDeps['skills'];
    /** Status & power: a supervisor to talk to (the fake in power.test.ts). */
    supervisor?: SupervisorApi;
    /** Status & power: short confirm life, a clock the test drives. */
    power?: PowerOptions;
    /** Capture what the server would log instead of turning logging off. */
    logger?: boolean | Record<string, unknown>;
    /** Config fields on top of the test config (e.g. device sign-in off). */
    configExtra?: Record<string, unknown>;
    workerApprovals?: AppDeps['workerApprovals'];
    safetyCommands?: AppDeps['safetyCommands'];
    tasks?: AppDeps['tasks'];
    bridge?: AppDeps['bridge'];
    workerUpdates?: AppDeps['workerUpdates'];
    /** What a folder's own files let an agent do there (tests plant their own folders). */
    configScan?: AppDeps['configScan'];
  } = {},
) {
  const config = makeConfig(options.staticDir, options.configExtra);
  // The app's own device store, so a test can pair another device.
  const devices = config.devices.enabled ? new Devices(config.stateDir) : undefined;
  const hub = new EventHub();
  const hermes = new FakeHermes();
  const paseo = new FakePaseo();
  const verifier = createAccessVerifier({ ...config.access!, keySource: keys.keySource });
  const feed = options.feed?.({ hub, hermes, stateDir: config.stateDir });
  const notifications = options.notifications?.({ hub, stateDir: config.stateDir });
  const app = await buildApp({
    config,
    verifier,
    ...(devices ? { devices } : {}),
    hub,
    sources: { hermes, paseo },
    logger: options.logger ?? false,
    ...(options.wsMaxLifetimeMs ? { wsMaxLifetimeMs: options.wsMaxLifetimeMs } : {}),
    ...(options.connectors ? { connectors: options.connectors } : {}),
    ...(options.speech ? { speech: options.speech } : {}),
    ...(options.cloudSpeech ? { cloudSpeech: options.cloudSpeech } : {}),
    ...(options.whatsappRouting ? { whatsappRouting: options.whatsappRouting } : {}),
    ...(options.phone ? { phone: options.phone } : {}),
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
    ...(options.power ? { power: options.power } : {}),
    ...(feed ? { feed } : {}),
    ...(notifications ? { notifications } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.workerApprovals ? { workerApprovals: options.workerApprovals } : {}),
    ...(options.safetyCommands ? { safetyCommands: options.safetyCommands } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(options.bridge ? { bridge: options.bridge } : {}),
    ...(options.workerUpdates ? { workerUpdates: options.workerUpdates } : {}),
    ...(options.configScan ? { configScan: options.configScan } : {}),
  });
  return { app, config, hub, hermes, paseo, feed, notifications, devices };
}

/** Headers our own frontend sends on an API call from the public origin, signed in as the test desktop. */
export function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: new URL(ORIGIN).host,
    'cf-access-jwt-assertion': token,
    cookie: DESKTOP_COOKIE,
    'x-wayroost-request': '1',
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

export function postHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return apiHeaders(token, { origin: ORIGIN, 'content-type': 'application/json', ...extra });
}
