import { BackgroundGate } from '../src/background.js';
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Approval, ScheduleJob, ScheduleList, ServerEvent } from '../../shared/protocol.js';
import { buildBridgeServer } from '../src/bridge/server.js';
import { EventHub } from '../src/hub.js';
import { encryptPayload, endpointProblem, PushSender } from '../src/feed/push.js';
import { BRIEF_JOB, Feed, SCOUT_JOB, SCOUT_SCHEDULES } from '../src/feed/service.js';
import { CardInput, FeedStore } from '../src/feed/store.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

const dir = () => mkdtempSync(join(tmpdir(), 'sb-feed-'));
const quietLog = { info() {}, warn() {}, error() {} };
const card = (key: string, extra: Partial<CardInput> = {}): CardInput => ({
  key,
  kind: 'reply',
  title: `About ${key}`,
  action: 'Draft a short reply',
  topic: 'book club',
  ...extra,
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// ---- Store ------------------------------------------------------------------------

describe('FeedStore', () => {
  it.each(['new', 'seen', 'later'] as const)('retries a failed close of a %s card without losing its saved decision', (status) => {
    const state = dir();
    const store = new FeedStore(state, () => 10_000);
    const key = 'task:demo_worker';
    const [created] = store.ingest('agent', [card(key)]).created;
    store.setStatus(created!.id, status, status === 'later' ? { laterUntil: 20_000 } : {});
    const before = { ...store.get(created!.id)! };
    const blocker = join(state, 'feed.json.tmp');
    mkdirSync(blocker);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => store.close(key)).toThrow();
      expect(store.get(created!.id)).toEqual(before);
      expect(new FeedStore(state).get(created!.id)).toEqual(before);
    }
    rmSync(blocker, { recursive: true });
    expect(store.close(key)?.status).toBe('done');
    expect(new FeedStore(state).get(created!.id)?.status).toBe('done');
    expect(store.get(created!.id)?.laterUntil).toBeUndefined();
    expect(store.close(key)).toBeUndefined();
  });

  it('adds cards once per key, updates them, and keeps your decisions', () => {
    let now = 1_000;
    const store = new FeedStore(dir(), () => now);
    const first = store.ingest('brief', [card('mail:a'), card('mail:b')]);
    expect(first.created.map((c) => c.key)).toEqual(['mail:a', 'mail:b']);
    expect(first.created[0]!.id).toMatch(/^[a-f0-9]{16}$/);

    now = 2_000;
    const again = store.ingest('scout', [card('mail:a'), card('mail:b', { title: 'New title' })]);
    expect(again.created).toEqual([]);
    expect(again.updated.map((c) => c.title)).toEqual(['New title']);

    const a = store.visible().find((c) => c.key === 'mail:a')!;
    store.setStatus(a.id, 'dismissed');
    const after = store.ingest('brief', [card('mail:a', { title: 'Changed again' })]);
    expect(after.updated).toEqual([]);
    expect(store.get(a.id)!.status).toBe('dismissed');
    expect(store.visible().map((c) => c.key)).toEqual(['mail:b']);
  });

  it('hides put-off cards until their time, then brings them back as new', () => {
    let now = 10_000;
    const store = new FeedStore(dir(), () => now);
    const [c] = store.ingest('brief', [card('event:1')]).created;
    store.setStatus(c!.id, 'later', { laterUntil: 20_000 });
    expect(store.visible()).toEqual([]);
    expect(store.ingest('scout', [card('event:1', { title: 'still later' })]).updated).toHaveLength(1);
    expect(store.visible()).toEqual([]);
    now = 19_999;
    expect(store.wakeLater()).toEqual([]);
    now = 20_000;
    expect(store.wakeLater().map((w) => w.status)).toEqual(['new']);
    expect(store.visible()).toHaveLength(1);
  });

  it('marks new cards seen, remembers turned-down topics, and survives a restart', () => {
    const state = dir();
    const store = new FeedStore(state);
    store.ingest('brief', [card('loop:x'), card('loop:y')]);
    expect(store.markSeen()).toHaveLength(2);
    expect(store.markSeen()).toEqual([]);
    store.addLessLike('Book club newsletters', 'Weekly bulletin');
    store.addLessLike('book club NEWSLETTERS', 'Another one');
    store.addLessLike('GitHub', 'PR review requested');
    expect(store.settings().lessLike.map((l) => l.topic)).toEqual(['GitHub', 'book club NEWSLETTERS']);
    store.removeLessLike('github');
    store.updateSettings({ level: 'high' });

    const reloaded = new FeedStore(state);
    expect(reloaded.visible().map((c) => c.status)).toEqual(['seen', 'seen']);
    expect(reloaded.settings().level).toBe('high');
    expect(reloaded.settings().lessLike.map((l) => l.topic)).toEqual(['book club NEWSLETTERS']);
  });

  it('forgets old cards, closed ones sooner, and keeps its file private', () => {
    const DAY = 86_400_000;
    let now = 100 * DAY;
    const state = dir();
    const store = new FeedStore(state, () => now);
    const [, closed] = store.ingest('brief', [card('mail:open'), card('mail:closed')]).created;
    store.setStatus(closed!.id, 'dismissed');
    now += 15 * DAY;
    store.ingest('scout', [card('mail:fresh')]);
    expect(store.all().map((c) => c.key).sort()).toEqual(['mail:fresh', 'mail:open']);
    now += 16 * DAY;
    const { removed } = store.ingest('scout', [card('mail:newer')]);
    expect(removed).toHaveLength(1);
    expect(store.all().map((c) => c.key).sort()).toEqual(['mail:fresh', 'mail:newer']);
    expect(statSync(join(state, 'feed.json')).mode & 0o777).toBe(0o600);
    now += 31 * DAY;
    expect(store.prune()).toHaveLength(2); // also without new cards (the service runs it every minute)
    expect(store.all()).toEqual([]);
  });

  it('notes each approval once', () => {
    const store = new FeedStore(dir());
    expect(store.markNotified('hermes:c1:a1')).toBe(true);
    expect(store.markNotified('hermes:c1:a1')).toBe(false);
  });

  it('cleans what the pulse sends: keys, links, lengths, unknown fields', () => {
    expect(CardInput.safeParse(card('nonsense')).success).toBe(false);
    expect(CardInput.safeParse(card('mail:../../etc')).success).toBe(true); // a key is only a label
    expect(CardInput.safeParse(card('mail:a b')).success).toBe(false);
    expect(CardInput.safeParse({ ...card('mail:a'), kind: 'launch' }).success).toBe(false);
    const parsed = CardInput.parse({
      ...card('mail:a'),
      title: `  Pay   now at https://evil.example/pay\u0007 ${'x'.repeat(200)}`,
      action: 'Open www.evil.example and log in',
      extra: 'dropped',
    });
    expect(parsed.title.startsWith('Pay now at [link] ')).toBe(true);
    expect(parsed.title.length).toBeLessThanOrEqual(100);
    expect(parsed.action).toBe('Open [link] and log in');
    expect('extra' in parsed).toBe(false);
    expect(CardInput.safeParse({ ...card('mail:a'), title: '   ' }).success).toBe(false);
    expect(CardInput.safeParse(card('MAIL:a')).success).toBe(false); // kinds are lowercase, one card per thing
    const emoji = String.fromCodePoint(0x1f600);
    const cut = [...CardInput.parse({ ...card('mail:a'), title: emoji.repeat(150) }).title];
    expect(cut).toHaveLength(100); // characters, not UTF-16 units: no emoji cut in half
    expect(cut.slice(0, 99).every((c) => c === emoji)).toBe(true);
    expect(cut[99]).toBe(String.fromCodePoint(0x2026));
  });

  it('removes what would hide or reorder text, including tag characters a model can read', () => {
    const hidden = (codes: number[]) => String.fromCodePoint(...codes);
    const tagged = `Draft a reply${hidden([0xe0020, 0xe0061, 0xe006c, 0xe0073, 0xe006f])} to Dana`;
    const isolated = `${hidden([0x2067])}evil${hidden([0x2069])} RSVP ${hidden([0x2066, 0x00ad, 0x3164, 0xfe0f, 0x061c])}due`;
    const parsed = CardInput.parse({ ...card('mail:a'), action: tagged, title: isolated });
    expect(parsed.action).toBe('Draft a reply to Dana');
    expect(parsed.title).toBe('evil RSVP due');
    expect([...parsed.title].every((c) => c.codePointAt(0)! < 0x7f)).toBe(true);
  });

  it('updates a card\'s topic too, and forgets a dropped one', () => {
    const store = new FeedStore(dir());
    store.ingest('brief', [card('mail:t', { topic: 'Book club forms' })]);
    expect(store.ingest('scout', [card('mail:t', { topic: 'Field trips' })]).updated.map((c) => c.topic)).toEqual(['Field trips']);
    const { topic: _gone, ...noTopic } = card('mail:t');
    const [updated] = store.ingest('scout', [noTopic]).updated;
    expect(updated && 'topic' in updated).toBe(false);
  });
});

// ---- Web Push ---------------------------------------------------------------------

/** The browser's side of RFC 8291, to check what Signalbox sends. */
function decrypt(body: Buffer, browserPrivate: Buffer, authSecret: Buffer): Buffer {
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  const info = (label: string) => Buffer.concat([Buffer.from(label), Buffer.from([0])]);
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(browserPrivate);
  const browserPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(serverPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([info('WebPush: info'), browserPublic, serverPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return plain.subarray(0, plain.length - 1);
}

const b64 = (s: string) => Buffer.from(s, 'base64url');

describe('Web Push', () => {
  it('encrypts exactly like RFC 8291 Appendix A', () => {
    // RFC 8291 Appendix A public test vectors: https://www.rfc-editor.org/rfc/rfc8291.html#appendix-A.
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b64('BTBZMqHH6r4Tts7J_aSIgg'),
      { salt: b64('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('only posts to the push services browsers use, over https', () => {
    expect(endpointProblem('https://fcm.googleapis.com/fcm/send/abc')).toBeNull();
    expect(endpointProblem('https://web.push.apple.com/QGh')).toBeNull();
    expect(endpointProblem('https://updates.push.services.mozilla.com/wpush/v2/x')).toBeNull();
    expect(endpointProblem('https://wns2-par02p.notify.windows.com/w/?token=x')).toBeNull();
    expect(endpointProblem('http://fcm.googleapis.com/x')).toBe('not https');
    expect(endpointProblem('https://127.0.0.1:19006/api')).toBe('unexpected port');
    expect(endpointProblem('https://fcm.googleapis.com.evil.example/x')).toBe('not a known push service');
    expect(endpointProblem('https://user:pw@fcm.googleapis.com/x')).toBe('credentials in the URL');
    expect(endpointProblem('not a url')).toBe('not a URL');
  });

  function browser() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = Buffer.alloc(16, 7);
    return {
      ecdh,
      auth,
      subscription: (endpoint = 'https://fcm.googleapis.com/fcm/send/device-1') => ({
        endpoint,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
      }),
    };
  }

  it('makes a new key rather than refusing to start over an unusable push.json', () => {
    const state = dir();
    writeFileSync(join(state, 'push.json'), JSON.stringify({ vapid: { d: 'bad', x: 'bad', y: 'bad' }, devices: [] }));
    const warnings: string[] = [];
    const push = new PushSender(state, 'https://wayroost.example.com', { warn: (_o, msg) => warnings.push(msg) }, undefined, new BackgroundGate('primary'));
    expect(Buffer.from(push.publicKey(), 'base64url')).toHaveLength(65);
    expect(warnings).toEqual(['push.json unusable: made a new notifications key']);
    expect(JSON.parse(readFileSync(join(state, 'push.json'), 'utf8')).vapid.d).not.toBe('bad');
    expect(JSON.parse(readFileSync(join(state, 'push.json.bad'), 'utf8')).vapid.d).toBe('bad'); // the old one is kept
  });

  it('signs with VAPID, encrypts for each device, and forgets devices that are gone', async () => {
    const state = dir();
    const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    let status = 201;
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Buffer) });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const push = new PushSender(state, 'https://wayroost.example.com', quietLog, fetchStub, new BackgroundGate('primary'));
    const phone = browser();
    expect(push.add(phone.subscription())).toBe(1);
    expect(() => push.add({ ...phone.subscription('https://evil.example/x') })).toThrow('not a known push service');
    expect(() =>
      push.add({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'A'.repeat(87), auth: phone.auth.toString('base64url') } }),
    ).toThrow('malformed keys');

    const message = { title: 'Hermes needs you', body: 'Run a shell command', url: '/c/hermes/x', tag: 't', ttl: 60, urgency: 'high' as const, topic: 'approvals' };
    const now = 1_700_000_000_000;
    expect(await push.send(message, now)).toEqual({ sent: 1, failed: 0, removed: 0 });
    const call = calls[0]!;
    expect(call.url).toBe('https://fcm.googleapis.com/fcm/send/device-1');
    expect(call.headers).toMatchObject({ ttl: '60', urgency: 'high', topic: 'approvals', 'content-encoding': 'aes128gcm' });
    expect(JSON.parse(decrypt(call.body, phone.ecdh.getPrivateKey(), phone.auth).toString())).toEqual({
      title: 'Hermes needs you',
      body: 'Run a shell command',
      url: '/c/hermes/x',
      tag: 't',
    });

    // VAPID: a token for that push service, signed by the key the browser subscribed with.
    const auth = /^vapid t=([^,]+), k=(.+)$/.exec(call.headers.authorization!)!;
    expect(auth[2]).toBe(push.publicKey());
    const [h, c, sig] = auth[1]!.split('.');
    expect(JSON.parse(b64(c!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 43_200, sub: 'https://wayroost.example.com' });
    const point = b64(push.publicKey());
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64(sig!))).toBe(true);

    // The same key after a restart; a device the service says is gone is dropped.
    const reloaded = new PushSender(state, 'https://wayroost.example.com', quietLog, fetchStub, new BackgroundGate('primary'));
    expect(reloaded.publicKey()).toBe(push.publicKey());
    status = 410;
    expect(await reloaded.send(message, now)).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(reloaded.devices()).toBe(0);
  });
});

// ---- The service ---------------------------------------------------------------------

class FakeSchedules {
  calls: string[] = [];
  jobs: ScheduleJob[] = [
    job('b1', BRIEF_JOB, '0 7 * * *'),
    job('s1', SCOUT_JOB, SCOUT_SCHEDULES.normal),
    job('x1', 'news-digest', '30 18 * * *'),
  ];
  async list(): Promise<ScheduleList> {
    return { jobs: this.jobs, targets: [] };
  }
  async setPaused(_source: string, id: string, paused: boolean) {
    this.calls.push(`${paused ? 'pause' : 'resume'}:${id}`);
    const j = this.jobs.find((x) => x.id === id)!;
    j.state = paused ? 'paused' : 'active';
  }
  async update(_source: string, id: string, changes: { schedule?: string }) {
    this.calls.push(`schedule:${id}:${changes.schedule}`);
    this.jobs.find((x) => x.id === id)!.scheduleInput = changes.schedule!;
  }
}

function job(id: string, name: string, scheduleInput: string): ScheduleJob {
  return {
    source: 'hermes', id, name, title: name, plumbing: false, schedule: scheduleInput, scheduleInput, state: 'active', skills: [], deliver: 'local',
    deliverLabel: 'Local', failureStreak: 0, runs: 0, trigger: false, script: true,
  };
}

function service(options: { now?: () => number; push?: PushSender; schedules?: FakeSchedules } = {}) {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.observe((e) => events.push(e));
  const created: string[] = [];
  const store = new FeedStore(dir(), options.now);
  const feed = new Feed({ background: new BackgroundGate('primary'),
    store,
    hub,
    hermes: {
      async createConversation(text: string) {
        created.push(text);
        return { id: 'chat-1' };
      },
    },
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.push ? { push: options.push } : {}),
    log: quietLog,
    ...(options.now ? { now: options.now } : {}),
    timeZone: 'UTC',
  });
  return { feed, hub, events, created, store };
}

const approval = (id: string): Approval => ({
  id,
  source: 'hermes',
  conversationId: 'conv-9',
  kind: 'permission',
  title: 'Run a shell command',
  detail: 'rm -rf ~/secret-project',
  options: [],
  createdAt: 1,
});

describe('Feed service', () => {
  it('publishes what the pulse posts and starts a Hermes chat on "Do it"', async () => {
    const { feed, events, created } = service({ now: () => Date.UTC(2026, 9, 2, 7, 3) });
    expect(feed.ingest('brief', [card('mail:18c2abc', { title: 'Dana: book club RSVP', detail: 'Due Thursday.' })])).toEqual({
      created: 1,
      updated: 0,
    });
    expect(events.map((e) => e.type)).toEqual(['feed_upsert']);
    const { id } = (await feed.list()).cards[0]!;

    const result = await feed.act(id, 'do');
    expect(result.chat).toEqual({ source: 'hermes', id: 'chat-1' });
    expect(result.card.status).toBe('done');
    expect(created[0]).toBe(
      [
        'From my For-you feed (morning brief, Fri, Oct 2, 7:03 AM): "Dana: book club RSVP"',
        'Due Thursday.',
        '',
        'Please: Draft a short reply',
        "(The email's Gmail message id is 18c2abc.)",
        'Check with me before you send anything or change anything.',
      ].join('\n'),
    );
    // A second tap opens the same chat instead of starting another.
    expect((await feed.act(id, 'do')).chat).toEqual({ source: 'hermes', id: 'chat-1' });
    expect(created).toHaveLength(1);

    // Handing a card to Hermes isn't finishing it: only "Done" tells the pulse to tick a loop off.
    expect(feed.preferences().done).toEqual([]);
    feed.ingest('scout', [card('loop:abc123', { kind: 'reminder' })]);
    const loop = (await feed.list()).cards.find((c) => c.key === 'loop:abc123')!;
    const handed = await feed.act(loop.id, 'do');
    expect(handed.card).toMatchObject({ status: 'seen', chat: { source: 'hermes' } }); // a reminder stays up
    expect((await feed.list()).cards.map((c) => c.key)).toContain('loop:abc123');
    expect(feed.preferences().done).toEqual([]);
    await feed.act(loop.id, 'done');
    expect(feed.preferences().done).toEqual(['loop:abc123']);
  });

  it('closes an open card once its subject is over, and never one you finished or turned down', async () => {
    const { feed, events, store } = service();
    feed.ingest('agent', [
      card('task:w1', { kind: 'warning', action: undefined }),
      card('task:w2', { kind: 'warning' }),
      card('task:w3', { kind: 'warning' }),
      card('task:w4', { kind: 'warning' }),
    ]);
    const byKey = (key: string) => store.all().find((c) => c.key === key)!;
    await feed.act(byKey('task:w2').id, 'dismiss');
    await feed.act(byKey('task:w3').id, 'later');
    await feed.act(byKey('task:w4').id, 'done');
    events.length = 0;
    for (const key of ['task:w1', 'task:w1', 'task:w2', 'task:w3', 'task:w4', 'task:none']) feed.close(key);
    // Published once each, only for the open ones (a put-off card is still open).
    expect(events.map((e) => (e.type === 'feed_upsert' ? `${e.card.key} ${e.card.status}` : e.type))).toEqual([
      'task:w1 done',
      'task:w3 done',
    ]);
    expect(byKey('task:w2').status).toBe('dismissed');
    expect(byKey('task:w3').laterUntil).toBeUndefined();
    expect((await feed.list()).cards).toEqual([]);
  });

  it('forgets old cards every minute too, and says so', () => {
    vi.useFakeTimers();
    try {
      const DAY = 86_400_000;
      let now = 50 * DAY;
      const { feed, events } = service({ now: () => now });
      feed.ingest('brief', [card('mail:old')]);
      feed.start();
      now += 31 * DAY;
      vi.advanceTimersByTime(60_000);
      expect(events.filter((e) => e.type === 'feed_removed')).toHaveLength(1);
      feed.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the app when old cards are forgotten', () => {
    const DAY = 86_400_000;
    let now = 50 * DAY;
    const { feed, events } = service({ now: () => now });
    feed.ingest('brief', [card('mail:old')]);
    now += 31 * DAY;
    feed.ingest('brief', [card('mail:new')]);
    expect(events.filter((e) => e.type === 'feed_removed')).toHaveLength(1);
  });

  it('puts cards off for three hours, but never into quiet hours', async () => {
    let now = Date.UTC(2026, 9, 2, 12, 0);
    const { feed, store } = service({ now: () => now });
    store.ingest('scout', [card('mail:a'), card('mail:b')]);
    const [a, b] = store.visible();
    expect((await feed.act(a!.id, 'later')).card.laterUntil).toBe(Date.UTC(2026, 9, 2, 15, 0));
    now = Date.UTC(2026, 9, 2, 19, 30); // +3h would be 22:30, inside 21:00-07:00
    expect((await feed.act(b!.id, 'later')).card.laterUntil).toBe(Date.UTC(2026, 9, 3, 7, 0));
    expect(feed.quiet(Date.UTC(2026, 9, 2, 6, 59))).toBe(true);
    expect(feed.quiet(Date.UTC(2026, 9, 2, 7, 0))).toBe(false);
    await feed.updateSettings({ quietHours: null });
    expect(feed.quiet(Date.UTC(2026, 9, 2, 23, 0))).toBe(false);
  });

  it('"Less like this" turns the topic down for later runs', async () => {
    const { feed, store } = service();
    store.ingest('scout', [card('mail:n', { topic: 'newsletters', title: 'Weekly digest' })]);
    await feed.act(store.visible()[0]!.id, 'less');
    expect(feed.preferences()).toMatchObject({
      level: 'normal',
      lessLike: [{ topic: 'newsletters', example: 'Weekly digest' }],
      cards: [{ key: 'mail:n', status: 'dismissed' }],
      done: [],
    });
    expect((await feed.list()).cards).toEqual([]);
  });

  it('tells the phone about approvals once, without the command, quiet hours or not', async () => {
    const sent: Array<{ title: string; body: string; url: string }> = [];
    const push = { devices: () => 1, send: async (m: { title: string; body: string; url: string }) => (sent.push(m), { sent: 1, failed: 0, removed: 0 }) };
    let now = Date.UTC(2026, 9, 2, 12, 0);
    const { feed, hub } = service({ now: () => now, push: push as unknown as PushSender });
    feed.start();
    cleanups.push(async () => feed.stop());
    hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    hub.publish({ type: 'approval_upsert', approval: approval('a1') });
    expect(sent).toEqual([{ title: 'Hermes needs you', body: 'Run a shell command', url: '/c/hermes/conv-9', tag: 'approval-hermes-conv-9', ttl: 3600, urgency: 'high', topic: 'approvals' }]);
    expect(JSON.stringify(sent)).not.toContain('secret-project');
    now = Date.UTC(2026, 9, 2, 23, 0);
    hub.publish({ type: 'approval_upsert', approval: approval('a2') });
    expect(sent).toHaveLength(2);
    await feed.updateSettings({ push: { approvals: false } });
    now = Date.UTC(2026, 9, 2, 12, 0);
    hub.publish({ type: 'approval_upsert', approval: approval('a3') });
    expect(sent).toHaveLength(2);
  });

  it('notifies about new cards only when asked to, and never in quiet hours', async () => {
    const sent: string[] = [];
    const push = { devices: () => 1, send: async (m: { body: string }) => (sent.push(m.body), { sent: 1, failed: 0, removed: 0 }) };
    let now = Date.UTC(2026, 9, 2, 12, 0);
    const { feed } = service({ now: () => now, push: push as unknown as PushSender });
    feed.ingest('scout', [card('mail:1')]);
    expect(sent).toEqual([]);
    await feed.updateSettings({ push: { cards: true } });
    feed.ingest('scout', [card('mail:2', { title: 'Haircut moved' }), card('mail:3')]);
    expect(sent).toEqual(['2 new · Haircut moved']);
    now = Date.UTC(2026, 9, 2, 23, 0);
    feed.ingest('scout', [card('mail:4')]);
    expect(sent).toHaveLength(1);
  });

  it('applies the proactivity level to the pulse jobs, and nothing else', async () => {
    const schedules = new FakeSchedules();
    const { feed } = service({ schedules });
    await feed.updateSettings({ level: 'high' });
    expect(schedules.calls).toEqual(['resume:b1', `schedule:s1:${SCOUT_SCHEDULES.high}`, 'resume:s1']);
    await feed.updateSettings({ level: 'low' });
    await feed.updateSettings({ level: 'off' });
    // A paused job that reads "running" (a stuck claim) is still resumed: nothing is inferred from its state.
    for (const j of schedules.jobs) j.state = 'running';
    await feed.updateSettings({ level: 'normal' });
    expect(schedules.calls).toEqual([
      'resume:b1',
      `schedule:s1:${SCOUT_SCHEDULES.high}`,
      'resume:s1',
      'resume:b1',
      'pause:s1',
      'pause:b1',
      'pause:s1',
      'resume:b1',
      `schedule:s1:${SCOUT_SCHEDULES.normal}`,
      'resume:s1',
    ]);
    expect(feed.settings()).toMatchObject({ level: 'normal', pulseFound: true });

    schedules.jobs.find((j) => j.name === BRIEF_JOB)!.state = 'done';
    await expect(feed.updateSettings({ level: 'high' })).rejects.toThrow('pulse-morning-brief has finished in Hermes');
    schedules.jobs = schedules.jobs.filter((j) => j.name !== SCOUT_JOB);
    await expect(feed.updateSettings({ level: 'high' })).rejects.toThrow('no pulse-morning-brief and pulse-scout');
    expect(feed.settings().level).toBe('normal');
  });

  it('finds the pulse jobs once Hermes is up, even if it started later', async () => {
    const schedules = new FakeSchedules();
    const all = schedules.jobs;
    let now = 1_000_000;
    let hermesUp = false;
    schedules.list = async () => {
      if (!hermesUp) throw new Error('connect ECONNREFUSED');
      return { jobs: all, targets: [] };
    };
    const { feed } = service({ schedules, now: () => now });
    feed.start();
    cleanups.push(async () => feed.stop());
    expect((await feed.list()).settings.pulseFound).toBe(false);
    hermesUp = true;
    now += 10_000;
    expect((await feed.list()).settings.pulseFound).toBe(false); // looks again at most every 30 s
    now += 30_000;
    expect((await feed.list()).settings.pulseFound).toBe(true);
  });
});

// ---- Routes ----------------------------------------------------------------------------

describe('For you routes', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  async function setup(withFeed = true) {
    const ctx = await makeApp(keys, {
      ...(withFeed
        ? {
            feed: ({ hub, hermes, stateDir }) =>
              new Feed({ background: new BackgroundGate('primary'), store: new FeedStore(stateDir), hub, hermes, log: quietLog, timeZone: 'UTC' }),
          }
        : {}),
    });
    cleanups.push(() => ctx.app.close());
    return ctx;
  }

  it('lists, acts and changes settings under the usual API rules', async () => {
    const { app, feed, hermes } = await setup();
    feed!.ingest('brief', [card('mail:abc')]);
    const list = (await app.inject({ url: '/api/feed', headers: apiHeaders(token) })).json();
    expect(list.cards).toHaveLength(1);
    expect(list.settings).toMatchObject({ level: 'normal', pushAvailable: false, pushDevices: 0 });
    const id = list.cards[0].id;

    const act = (body: unknown, cardId = id, headers = postHeaders(token)) =>
      app.inject({ method: 'POST', url: `/api/feed/${cardId}/action`, headers, payload: JSON.stringify(body) });
    expect((await act({ action: 'launch' })).statusCode).toBe(400);
    expect((await act({ action: 'do' }, '0123456789abcdef')).statusCode).toBe(404);
    expect((await act({ action: 'do' }, 'not-a-card')).statusCode).toBe(400);
    expect((await act({ action: 'do' }, id, { ...postHeaders(token), 'x-wayroost-request': '' })).statusCode).toBe(403);
    const done = await act({ action: 'do' });
    expect(done.json()).toMatchObject({ card: { status: 'done' }, chat: { source: 'hermes', id: 'new-hermes' } });
    expect(hermes.calls.some((c) => c.startsWith('create:From my For-you feed'))).toBe(true);

    const put = (body: unknown) =>
      app.inject({ method: 'PUT', url: '/api/feed/settings', headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await put({ quietHours: { start: '22:00', end: '06:30' }, push: { cards: true } })).json()).toMatchObject({
      quietHours: { start: '22:00', end: '06:30' },
      push: { approvals: true, cards: true },
    });
    expect((await put({ quietHours: { start: '25:00', end: '06:30' } })).statusCode).toBe(400);
    expect((await put({ level: 'max' })).statusCode).toBe(400);
    expect((await put({ extra: 1 })).statusCode).toBe(400);
    // No scheduled jobs here, so a level change is refused rather than half-done.
    expect((await put({ level: 'high' })).statusCode).toBe(409);

    // This Feed has no push sender (Signalbox off https), so no key is offered.
    expect((await app.inject({ url: '/api/push/key', headers: apiHeaders(token) })).statusCode).toBe(409);
  });

  it('is absent when turned off', async () => {
    const { app } = await setup(false);
    expect((await app.inject({ url: '/api/feed', headers: apiHeaders(token) })).statusCode).toBe(404);
  });

  it('takes the pulse cards on the bridge listener, with its token', async () => {
    const hub = new EventHub();
    const feed = new Feed({ background: new BackgroundGate('primary'),
      store: new FeedStore(dir()),
      hub,
      hermes: { createConversation: async () => ({ id: 'x' }) },
      log: quietLog,
    });
    const server = await buildBridgeServer({ background: new BackgroundGate('primary'),
      bridge: { call: async () => ({}) } as never,
      token: 'pulse-token-0123456789abcdef0123456789',
      port: 19012,
      log: quietLog,
      feed,
    });
    cleanups.push(() => server.close());
    const call = (method: 'GET' | 'POST', url: string, body?: unknown, auth = 'Bearer pulse-token-0123456789abcdef0123456789') =>
      server.inject({
        method,
        url,
        headers: { host: '127.0.0.1:19012', authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    expect((await call('GET', '/pulse/v1/preferences', undefined, 'Bearer wrong')).statusCode).toBe(401);
    const posted = await call('POST', '/pulse/v1/cards', {
      source: 'scout',
      cards: [card('mail:1'), { key: 'bad key', kind: 'reply', title: 'x' }, { ...card('event:2'), kind: 'prepare' }],
    });
    expect(posted.json()).toEqual({ ok: true, result: { created: 2, updated: 0, rejected: 1 } });
    expect((await call('POST', '/pulse/v1/cards', { source: 'nobody', cards: [] })).statusCode).toBe(400);
    expect((await call('POST', '/pulse/v1/cards', { source: 'scout', cards: Array(21).fill(card('mail:x')) })).statusCode).toBe(400);
    const prefs = (await call('GET', '/pulse/v1/preferences')).json();
    expect(prefs.result).toMatchObject({ level: 'normal', lessLike: [], done: [] });
    expect(prefs.result.cards.map((c: { key: string }) => c.key).sort()).toEqual(['event:2', 'mail:1']);
  });
});
